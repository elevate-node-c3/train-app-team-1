import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeWebhookController } from './controllers/stripe-webhook.controller.js';
import type { SavedCardsService } from './services/saved-cards.service.js';
import { StripeService } from './services/stripe.service.js';
import type { DataSource } from 'typeorm';
import type { ChargeWebhookService } from '../charges/services/charge-webhook.service.js';

describe('StripeWebhookController', () => {
  afterEach(() => vi.unstubAllEnvs());
  const event = {
    type: 'setup_intent.succeeded',
    data: { object: { id: 'seti_test' } },
  } as unknown as Stripe.Event;

  it('returns a bad request only when Stripe signature verification fails', async () => {
    const constructEvent = vi.fn(() => {
      throw new Error('invalid signature');
    });
    const handleWebhookEvent = vi.fn();
    const controller = new StripeWebhookController(
      { constructEvent } as unknown as StripeService,
      { handleWebhookEvent } as unknown as SavedCardsService,
      { record: vi.fn() } as unknown as ChargeWebhookService,
    );

    await expect(
      controller.handleStripeWebhook(
        { rawBody: Buffer.from('{}') } as never,
        'invalid',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('lets processing failures propagate so Stripe can retry delivery', async () => {
    const processingError = new Error('payment database unavailable');
    const constructEvent = vi.fn().mockReturnValue(event);
    const handleWebhookEvent = vi.fn().mockRejectedValue(processingError);
    const controller = new StripeWebhookController(
      { constructEvent } as unknown as StripeService,
      { handleWebhookEvent } as unknown as SavedCardsService,
      { record: vi.fn() } as unknown as ChargeWebhookService,
    );

    await expect(
      controller.handleStripeWebhook(
        { rawBody: Buffer.from('{}') } as never,
        'valid-signature',
      ),
    ).rejects.toBe(processingError);
  });

  it('uses the real SDK signature verifier before durably acknowledging a charge event', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_validForSignatureTests');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_signaturetest');
    const service = new StripeService({} as DataSource);
    const record = vi.fn().mockResolvedValue('recorded');
    const controller = new StripeWebhookController(
      service,
      {} as SavedCardsService,
      { record } as unknown as ChargeWebhookService,
    );
    const payload = JSON.stringify({
      id: 'evt_verified',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_1',
          status: 'succeeded',
          amount: 6955,
          amount_received: 6955,
          currency: 'egp',
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_signaturetest',
    });
    await expect(
      controller.handleStripeWebhook(
        { rawBody: Buffer.from(payload) } as never,
        signature,
      ),
    ).resolves.toEqual({ received: true });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_verified' }),
    );
    record.mockClear();
    await expect(
      controller.handleStripeWebhook(
        { rawBody: Buffer.from(payload.replace('6955', '1')) } as never,
        signature,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not acknowledge a verified charge when durable inbox persistence fails', async () => {
    const error = new Error('inbox database unavailable');
    const controller = new StripeWebhookController(
      {
        constructEvent: () => ({ ...event, type: 'payment_intent.succeeded' }),
      } as unknown as StripeService,
      {} as SavedCardsService,
      {
        record: vi.fn().mockRejectedValue(error),
      } as unknown as ChargeWebhookService,
    );
    await expect(
      controller.handleStripeWebhook(
        { rawBody: Buffer.from('{}') } as never,
        'valid',
      ),
    ).rejects.toBe(error);
  });
});
