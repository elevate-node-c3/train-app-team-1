import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { ErrorCode } from '@app/contracts';
import { SavedCardsService } from './saved-cards.service.js';
import type { StripeService } from './stripe.service.js';

describe('SavedCardsService', () => {
  let service: SavedCardsService;
  let mockDataSource: { query: ReturnType<typeof vi.fn> };
  let mockStripeService: {
    getOrCreateCustomer: ReturnType<typeof vi.fn>;
    createSetupIntent: ReturnType<typeof vi.fn>;
    retrieveSetupIntent: ReturnType<typeof vi.fn>;
    detachPaymentMethod: ReturnType<typeof vi.fn>;
  };

  const accountId = '11111111-1111-4111-8111-111111111111';
  const otherAccountId = '22222222-2222-4222-8222-222222222222';
  const customerId = 'cus_test_123';

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn(),
    };
    mockStripeService = {
      getOrCreateCustomer: vi.fn().mockResolvedValue(customerId),
      createSetupIntent: vi.fn().mockResolvedValue({
        setupIntentId: 'seti_123',
        clientSecret: 'seti_123_secret_xyz',
        publishableKey: 'pk_test_123',
      }),
      retrieveSetupIntent: vi.fn(),
      detachPaymentMethod: vi.fn().mockResolvedValue(undefined),
    };

    service = new SavedCardsService(
      mockDataSource as unknown as DataSource,
      mockStripeService as unknown as StripeService,
    );
  });

  describe('createSetupIntent', () => {
    it('creates setup intent for traveller Stripe customer', async () => {
      const result = await service.createSetupIntent(accountId);
      expect(mockStripeService.getOrCreateCustomer).toHaveBeenCalledWith(
        accountId,
      );
      expect(mockStripeService.createSetupIntent).toHaveBeenCalledWith(
        customerId,
      );
      expect(result.setupIntentId).toBe('seti_123');
      expect(result.clientSecret).toBe('seti_123_secret_xyz');
    });
  });

  describe('listCards', () => {
    it('returns empty array when traveller has no saved cards', async () => {
      mockDataSource.query.mockResolvedValue([]);
      const cards = await service.listCards(accountId);
      expect(cards).toEqual([]);
    });

    it('marks exactly one valid card as default by last_used_at or newest, and never marks expired card', async () => {
      const futureYear = new Date().getUTCFullYear() + 2;
      const pastYear = new Date().getUTCFullYear() - 2;

      mockDataSource.query.mockResolvedValue([
        {
          id: 'card-1',
          account_id: accountId,
          stripe_customer_id: customerId,
          stripe_payment_method_id: 'pm_1',
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: futureYear,
          cardholder_name: 'Ahmed ****4242',
          fingerprint: 'fp_1',
          status: 'active',
          last_used_at: new Date('2026-11-01T10:00:00Z'),
          created_at: new Date('2026-10-01T10:00:00Z'),
        },
        {
          id: 'card-2',
          account_id: accountId,
          stripe_customer_id: customerId,
          stripe_payment_method_id: 'pm_2',
          brand: 'mastercard',
          last4: '5555',
          exp_month: 6,
          exp_year: pastYear, // Expired card
          cardholder_name: 'Ahmed ****5555',
          fingerprint: 'fp_2',
          status: 'active',
          last_used_at: new Date('2026-11-10T10:00:00Z'), // Used recently but expired
          created_at: new Date('2026-09-01T10:00:00Z'),
        },
        {
          id: 'card-3',
          account_id: accountId,
          stripe_customer_id: customerId,
          stripe_payment_method_id: 'pm_3',
          brand: 'visa',
          last4: '1111',
          exp_month: 8,
          exp_year: futureYear,
          cardholder_name: 'Ahmed ****1111',
          fingerprint: 'fp_3',
          status: 'active',
          last_used_at: null,
          created_at: new Date('2026-10-15T10:00:00Z'),
        },
      ]);

      const cards = await service.listCards(accountId);

      expect(cards).toHaveLength(3);
      // Card 1: valid, used, marked as default
      expect(cards[0].id).toBe('card-1');
      expect(cards[0].canPay).toBe(true);
      expect(cards[0].isExpired).toBe(false);
      expect(cards[0].isDefault).toBe(true);

      // Card 2: expired, canPay is false, never default
      expect(cards[1].id).toBe('card-2');
      expect(cards[1].canPay).toBe(false);
      expect(cards[1].isExpired).toBe(true);
      expect(cards[1].isDefault).toBe(false);

      // Card 3: valid, not used, not default since card-1 was default
      expect(cards[2].id).toBe('card-3');
      expect(cards[2].canPay).toBe(true);
      expect(cards[2].isExpired).toBe(false);
      expect(cards[2].isDefault).toBe(false);
    });
  });

  describe('confirmSetup', () => {
    it('refuses if setup intent status is not succeeded', async () => {
      mockStripeService.retrieveSetupIntent.mockResolvedValue({
        id: 'seti_pending',
        status: 'requires_action',
        customer: customerId,
      });

      await expect(
        service.confirmSetup(accountId, 'seti_pending'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PAYLOAD,
      });
    });

    it('refuses with RESOURCE_NOT_FOUND (404) if setup customer belongs to another account', async () => {
      mockStripeService.retrieveSetupIntent.mockResolvedValue({
        id: 'seti_other',
        status: 'succeeded',
        customer: 'cus_other_stranger',
        payment_method: {
          id: 'pm_other',
          type: 'card',
          customer: customerId,
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            fingerprint: 'fp_other',
          },
        },
      });

      mockDataSource.query.mockResolvedValueOnce([
        { stripe_customer_id: customerId },
      ]);

      await expect(
        service.confirmSetup(accountId, 'seti_other'),
      ).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    });

    it('handles duplicate card as quiet success without creating a second row', async () => {
      mockStripeService.retrieveSetupIntent.mockResolvedValue({
        id: 'seti_dup',
        status: 'succeeded',
        customer: customerId,
        payment_method: {
          id: 'pm_new_dup',
          type: 'card',
          customer: customerId,
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            fingerprint: 'fp_existing',
          },
        },
      });

      mockDataSource.query
        .mockResolvedValueOnce([{ stripe_customer_id: customerId }]) // customer query
        .mockResolvedValueOnce([
          // duplicate card query
          {
            id: 'card-existing-id',
            account_id: accountId,
            stripe_customer_id: customerId,
            stripe_payment_method_id: 'pm_old',
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            cardholder_name: 'Cardholder ****4242',
            fingerprint: 'fp_existing',
            status: 'active',
            created_at: new Date(),
          },
        ]);

      const card = await service.confirmSetup(accountId, 'seti_dup');

      expect(card.id).toBe('card-existing-id');
      expect(mockStripeService.detachPaymentMethod).toHaveBeenCalledWith(
        'pm_new_dup',
        customerId,
      );
      expect(mockDataSource.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO saved_card'),
        expect.anything(),
      );
    });
  });

  describe('deleteCard', () => {
    it('detaches from Stripe and marks status as detached', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([
          {
            id: 'card-1',
            account_id: accountId,
            stripe_customer_id: customerId,
            stripe_payment_method_id: 'pm_stripe_1',
            status: 'active',
          },
        ]) // select
        .mockResolvedValueOnce([]); // update

      const success = await service.deleteCard(accountId, 'card-1');

      expect(success).toBe(true);
      expect(mockStripeService.detachPaymentMethod).toHaveBeenCalledWith(
        'pm_stripe_1',
        customerId,
      );
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'detached'"),
        ['card-1'],
      );
    });

    it('throws RESOURCE_NOT_FOUND (404) when deleting another traveller card (BR-09)', async () => {
      mockDataSource.query.mockResolvedValueOnce([]); // Not found for caller

      await expect(
        service.deleteCard(otherAccountId, 'card-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_NOT_FOUND,
      });
    });
  });

  describe('handleWebhookEvent', () => {
    it('processes setup_intent.succeeded and persists card', async () => {
      mockDataSource.query
        .mockResolvedValueOnce([{ account_id: accountId }]) // find customer
        .mockResolvedValueOnce([]) // duplicate check: none
        .mockResolvedValueOnce([]) // insert
        .mockResolvedValueOnce([
          {
            id: 'card-webhook-id',
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            cardholder_name: 'Cardholder ****4242',
            fingerprint: 'fp_wh',
            status: 'active',
            created_at: new Date(),
          },
        ]); // select after insert

      mockStripeService.retrieveSetupIntent.mockResolvedValue({
        id: 'seti_wh',
        status: 'succeeded',
        customer: customerId,
        payment_method: {
          id: 'pm_wh',
          type: 'card',
          customer: customerId,
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            fingerprint: 'fp_wh',
          },
        },
      });

      const event = {
        type: 'setup_intent.succeeded',
        data: {
          object: {
            id: 'seti_wh',
            customer: customerId,
            payment_method: 'pm_wh',
          },
        },
      } as unknown as Stripe.Event;

      await service.handleWebhookEvent(event);

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO saved_card'),
        expect.anything(),
      );
    });

    it('ignores webhook for unknown Stripe customer safely without throwing', async () => {
      mockDataSource.query.mockResolvedValueOnce([]); // customer not found

      const event = {
        type: 'setup_intent.succeeded',
        data: {
          object: {
            id: 'seti_unknown',
            customer: 'cus_unknown',
            payment_method: 'pm_unknown',
          },
        },
      } as unknown as Stripe.Event;

      await expect(service.handleWebhookEvent(event)).resolves.not.toThrow();
    });
  });
});
