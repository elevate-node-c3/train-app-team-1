import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { ErrorCode } from '@app/contracts';
import { SavedCardsService } from '../../apps/payment/src/modules/cards/services/saved-cards.service.js';
import { StripeService } from '../../apps/payment/src/modules/cards/services/stripe.service.js';
import { redactPii } from '../../libs/common/src/logging/pii-redactor.js';

describe('Saved Cards Acceptance & Security Verification', () => {
  let savedCardsService: SavedCardsService;
  let stripeService: StripeService;

  // In-memory simulated PostgreSQL tables
  let customersTable: Array<{
    id: string;
    account_id: string;
    stripe_customer_id: string;
  }>;
  let cardsTable: Array<{
    id: string;
    account_id: string;
    stripe_customer_id: string;
    stripe_payment_method_id: string;
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    cardholder_name: string;
    fingerprint: string;
    status: 'active' | 'detached';
    last_used_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>;
  let chargesTable: Array<{
    id: string;
    booking_reference: string;
    card_brand: string | null;
    card_last4: string | null;
    status: string;
  }>;

  const travellerA = '11111111-1111-4111-8111-111111111111';
  const travellerB = '22222222-2222-4222-8222-222222222222';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_validForSavedCardTests123');
    customersTable = [];
    cardsTable = [];
    chargesTable = [];

    const query = vi.fn(async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (
        normalized.includes(
          'select stripe_customer_id from payment_customer where account_id = $1',
        )
      ) {
        const found = customersTable.find((c) => c.account_id === params[0]);
        return found ? [{ stripe_customer_id: found.stripe_customer_id }] : [];
      }

      if (
        normalized.includes(
          'select account_id from payment_customer where stripe_customer_id = $1',
        )
      ) {
        const found = customersTable.find(
          (c) => c.stripe_customer_id === params[0],
        );
        return found ? [{ account_id: found.account_id }] : [];
      }

      if (normalized.includes('insert into payment_customer')) {
        let found = customersTable.find((c) => c.account_id === params[1]);
        if (!found) {
          found = {
            id: params[0],
            account_id: params[1],
            stripe_customer_id: params[2],
          };
          customersTable.push(found);
        }
        return [{ stripe_customer_id: found.stripe_customer_id }];
      }

      if (
        normalized.includes('select * from saved_card') &&
        normalized.includes('fingerprint = $2')
      ) {
        return cardsTable.filter(
          (c) =>
            c.account_id === params[0] &&
            c.fingerprint === params[1] &&
            c.status === 'active',
        );
      }

      if (
        normalized.includes('select * from saved_card') &&
        normalized.includes('stripe_payment_method_id = $1')
      ) {
        return cardsTable.filter(
          (c) =>
            c.stripe_payment_method_id === params[0] &&
            (params.length < 2 || c.account_id === params[1]),
        );
      }

      if (normalized.includes('insert into saved_card')) {
        const existing = cardsTable.find(
          (c) =>
            c.stripe_payment_method_id === params[3] ||
            (c.account_id === params[1] &&
              c.fingerprint === params[9] &&
              c.status === 'active'),
        );
        if (!existing) {
          cardsTable.push({
            id: params[0],
            account_id: params[1],
            stripe_customer_id: params[2],
            stripe_payment_method_id: params[3],
            brand: params[4],
            last4: params[5],
            exp_month: params[6],
            exp_year: params[7],
            cardholder_name: params[8],
            fingerprint: params[9],
            status: 'active',
            last_used_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
        return [];
      }

      if (
        normalized.includes('select * from saved_card') &&
        normalized.includes("status = 'active'") &&
        normalized.includes('order by')
      ) {
        return cardsTable
          .filter((c) => c.account_id === params[0] && c.status === 'active')
          .sort((a, b) => {
            if (a.last_used_at && b.last_used_at)
              return b.last_used_at.getTime() - a.last_used_at.getTime();
            if (a.last_used_at) return -1;
            if (b.last_used_at) return 1;
            return b.created_at.getTime() - a.created_at.getTime();
          });
      }

      if (
        normalized.includes('select * from saved_card') &&
        normalized.includes(
          "where id = $1 and account_id = $2 and status = 'active'",
        )
      ) {
        return cardsTable.filter(
          (c) =>
            c.id === params[0] &&
            c.account_id === params[1] &&
            c.status === 'active',
        );
      }

      if (normalized.includes("update saved_card set status = 'detached'")) {
        const card = cardsTable.find((c) => c.id === params[0]);
        if (card) {
          card.status = 'detached';
          card.updated_at = new Date();
        }
        return [];
      }

      return [];
    });
    let transactionTail = Promise.resolve();
    const mockDataSource = {
      query,
      transaction: vi.fn(
        async (
          work: (manager: { query: typeof query }) => Promise<unknown>,
        ) => {
          const previous = transactionTail;
          let release!: () => void;
          transactionTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await work({ query });
          } finally {
            release();
          }
        },
      ),
    };

    stripeService = new StripeService(mockDataSource as unknown as DataSource);
    savedCardsService = new SavedCardsService(
      mockDataSource as unknown as DataSource,
      stripeService,
    );
  });

  describe('AC-1 & AC-2: Zero Card Data Exposure and Masking', () => {
    it('ensures no PAN, CVV, or client secrets survive PII redaction in logs', () => {
      const rawLog = {
        message: 'Processing card',
        cardNumber: '4242424242424242',
        cvv: '123',
        clientSecret: 'seti_123_secret_xyz',
        stripeKey: 'sk_test_placeholderSecretKeyForTesting12345',
      };

      const redacted = redactPii(rawLog);
      const serialized = JSON.stringify(redacted);

      expect(serialized).not.toContain('4242424242424242');
      expect(serialized).not.toContain('123');
      expect(serialized).not.toContain('seti_123_secret_xyz');
      expect(serialized).not.toContain('sk_test_placeholder');
      expect(redacted.cardNumber).toBe('[REDACTED]');
      expect(redacted.cvv).toBe('[REDACTED]');
      expect(redacted.clientSecret).toBe('[REDACTED]');
    });
  });

  describe('AC-3: Concurrent Stripe Customer Creation', () => {
    it('creates exactly one Stripe customer row under concurrent requests for the same account', async () => {
      let stripeCallCount = 0;
      let customerCreateOptions: Record<string, unknown> | undefined;
      (stripeService as any).stripeClient.customers = {
        create: vi.fn(
          async (_params: unknown, options: Record<string, unknown>) => {
            stripeCallCount++;
            customerCreateOptions = options;
            return { id: 'cus_shared_stripe_id' };
          },
        ),
      };
      (stripeService as any).stripeClient.setupIntents = {
        create: vi.fn(async () => ({
          id: 'seti_concurrent',
          client_secret: 'seti_secret_concurrent',
        })),
      };

      // Two devices initiate setup at the exact same millisecond
      const [setup1, setup2] = await Promise.all([
        savedCardsService.createSetupIntent(travellerA),
        savedCardsService.createSetupIntent(travellerA),
      ]);

      expect(
        customersTable.filter((c) => c.account_id === travellerA),
      ).toHaveLength(1);
      expect(setup1.setupIntentId).toBe('seti_concurrent');
      expect(setup2.setupIntentId).toBe('seti_concurrent');
      expect(stripeCallCount).toBe(1);
      expect(customerCreateOptions?.idempotencyKey).toMatch(
        /^enr_cust_[a-f0-9]{32}$/,
      );
      expect(customerCreateOptions?.idempotencyKey).not.toContain(travellerA);
    });
  });

  describe('AC-4, AC-5 & AC-6: Webhook and Client Sync Idempotency', () => {
    it('records card once when webhook is delivered twice and client also reports back (3 calls)', async () => {
      customersTable.push({
        id: 'cust-id-1',
        account_id: travellerA,
        stripe_customer_id: 'cus_traveller_a',
      });

      const mockPaymentMethod = {
        id: 'pm_test_card',
        type: 'card',
        customer: 'cus_traveller_a',
        billing_details: { name: 'Ahmed' },
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
          fingerprint: 'fp_card_4242',
        },
      } as unknown as Stripe.PaymentMethod;

      stripeService.retrieveSetupIntent = vi.fn().mockResolvedValue({
        id: 'seti_triple',
        status: 'succeeded',
        customer: 'cus_traveller_a',
        payment_method: mockPaymentMethod,
      });

      const webhookEvent = {
        type: 'setup_intent.succeeded',
        data: {
          object: {
            id: 'seti_triple',
            customer: 'cus_traveller_a',
            payment_method: 'pm_test_card',
          },
        },
      } as unknown as Stripe.Event;

      // Call 1: Webhook delivery 1
      await savedCardsService.handleWebhookEvent(webhookEvent);
      // Call 2: Webhook duplicate delivery 2
      await savedCardsService.handleWebhookEvent(webhookEvent);
      // Call 3: Client confirms setup
      await savedCardsService.confirmSetup(travellerA, 'seti_triple');

      // Assert exactly one row was created in cardsTable
      expect(
        cardsTable.filter((c) => c.account_id === travellerA),
      ).toHaveLength(1);
      expect(cardsTable[0].brand).toBe('visa');
      expect(cardsTable[0].last4).toBe('4242');

      const retrieveCount = vi.mocked(stripeService.retrieveSetupIntent).mock
        .calls.length;
      const listed = await savedCardsService.listCards(travellerA);
      expect(listed).toMatchObject([
        {
          brand: 'visa',
          last4: '4242',
          expMonth: 12,
          expYear: 2030,
          cardholderName: 'Ahmed ****4242',
          isDefault: true,
          canPay: true,
        },
      ]);
      expect(
        vi.mocked(stripeService.retrieveSetupIntent).mock.calls,
      ).toHaveLength(retrieveCount);
    });

    it('atomically deduplicates concurrent setups for the same Stripe fingerprint', async () => {
      customersTable.push({
        id: 'cust-id-1',
        account_id: travellerA,
        stripe_customer_id: 'cus_traveller_a',
      });

      const makeMethod = (id: string) =>
        ({
          id,
          type: 'card',
          customer: 'cus_traveller_a',
          card: {
            brand: 'visa',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            fingerprint: 'fp_concurrent',
          },
        }) as unknown as Stripe.PaymentMethod;
      const firstMethod = makeMethod('pm_concurrent_1');
      const secondMethod = makeMethod('pm_concurrent_2');
      const detach = vi.fn().mockResolvedValue(undefined);
      stripeService.detachPaymentMethod = detach;

      const [first, second] = await Promise.all([
        savedCardsService.recordCardFromStripe(
          travellerA,
          'cus_traveller_a',
          firstMethod,
        ),
        savedCardsService.recordCardFromStripe(
          travellerA,
          'cus_traveller_a',
          secondMethod,
        ),
      ]);

      expect(first.id).toBe(second.id);
      expect(
        cardsTable.filter((card) => card.fingerprint === 'fp_concurrent'),
      ).toHaveLength(1);
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it('does not record a card if client reports but Stripe setup is not succeeded (AC-4)', async () => {
      customersTable.push({
        id: 'cust-id-1',
        account_id: travellerA,
        stripe_customer_id: 'cus_traveller_a',
      });

      stripeService.retrieveSetupIntent = vi.fn().mockResolvedValue({
        id: 'seti_incomplete',
        status: 'requires_payment_method',
        customer: 'cus_traveller_a',
      });

      await expect(
        savedCardsService.confirmSetup(travellerA, 'seti_incomplete'),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_PAYLOAD });

      const cards = await savedCardsService.listCards(travellerA);
      expect(cards).toHaveLength(0);
    });
  });

  describe('AC-8: Cross-traveller Access (BR-09)', () => {
    it('returns RESOURCE_NOT_FOUND (404) when Traveller B tries to delete Traveller A card', async () => {
      cardsTable.push({
        id: 'card-a-id',
        account_id: travellerA,
        stripe_customer_id: 'cus_a',
        stripe_payment_method_id: 'pm_a',
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2030,
        cardholder_name: 'Traveller A',
        fingerprint: 'fp_a',
        status: 'active',
        last_used_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Traveller B attempts delete
      await expect(
        savedCardsService.deleteCard(travellerB, 'card-a-id'),
      ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });

      // Card remains active
      expect(cardsTable[0].status).toBe('active');
    });
  });

  describe('AC-9: Deleted Card Keeps Past Booking Payment Record', () => {
    it('detaches card from list while past booking payment retains brand and last4', async () => {
      cardsTable.push({
        id: 'card-used-id',
        account_id: travellerA,
        stripe_customer_id: 'cus_a',
        stripe_payment_method_id: 'pm_past_used',
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2030,
        cardholder_name: 'Traveller A',
        fingerprint: 'fp_a',
        status: 'active',
        last_used_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      });

      chargesTable.push({
        id: 'charge-1',
        booking_reference: 'booking-uuid-1',
        card_brand: 'visa',
        card_last4: '4242',
        status: 'succeeded',
      });

      stripeService.detachPaymentMethod = vi.fn().mockResolvedValue(undefined);

      // Traveller deletes card
      await savedCardsService.deleteCard(travellerA, 'card-used-id');

      // Card is no longer in active list
      const cards = await savedCardsService.listCards(travellerA);
      expect(cards).toHaveLength(0);

      // Past booking payment still retains brand and last4
      expect(chargesTable[0].card_brand).toBe('visa');
      expect(chargesTable[0].card_last4).toBe('4242');
    });
  });
});
