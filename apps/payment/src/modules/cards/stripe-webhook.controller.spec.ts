import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { StripeWebhookController } from './controllers/stripe-webhook.controller.js';
import type { SavedCardsService } from './services/saved-cards.service.js';
import type { StripeService } from './services/stripe.service.js';
import type { ChargeWebhookService } from '../charges/services/charge-webhook.service.js';

describe('StripeWebhookController', () => {
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
});
