import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import type { ChargeWebhookService } from './services/charge-webhook.service.js';
import type { PaymentIntentService } from './services/payment-intent.service.js';
import type { StripeEventRepository } from './repositories/stripe-event.repository.js';
import { PaymentRecoveryWorker } from './payment-recovery.worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PaymentRecoveryWorker production lifecycle', () => {
  function fixture(whenReady: Promise<void> = Promise.resolve()) {
    const webhooks = { processPending: vi.fn().mockResolvedValue(0) };
    const intents = { recoverPending: vi.fn().mockResolvedValue(undefined) };
    const events = {
      recoveryCounts: vi.fn().mockResolvedValue({ rejectedStripeEvents: 0 }),
    };
    const worker = new PaymentRecoveryWorker(
      webhooks as unknown as ChargeWebhookService,
      intents as unknown as PaymentIntentService,
      events as unknown as StripeEventRepository,
      { whenReady } as SchemaReadinessGate,
    );
    return { worker, webhooks, intents, events };
  }

  it('starts after migrations and drains retrieval-backed evidence without another HTTP request', async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const { worker, webhooks, intents } = fixture(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    worker.onApplicationBootstrap();
    await Promise.resolve();
    expect(webhooks.processPending).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() =>
      expect(intents.recoverPending).toHaveBeenCalledTimes(1),
    );
    expect(webhooks.processPending).toHaveBeenCalledTimes(2);
    await worker.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(intents.recoverPending).toHaveBeenCalledTimes(1);
  });

  it('continues scanning after a temporary database failure', async () => {
    vi.useFakeTimers();
    const { worker, webhooks, intents } = fixture();
    webhooks.processPending.mockRejectedValueOnce(
      new Error('database temporarily unavailable'),
    );
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(intents.recoverPending).toHaveBeenCalledTimes(1);
    await worker.beforeApplicationShutdown();
  });

  it('can be explicitly disabled without losing persisted recovery state', async () => {
    vi.stubEnv('PAYMENT_RECOVERY_ENABLED', 'false');
    const { worker, webhooks } = fixture();
    worker.onApplicationBootstrap();
    expect(webhooks.processPending).not.toHaveBeenCalled();
    await worker.beforeApplicationShutdown();
  });
});
