import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_QUEUE,
  clearMailpit,
  compose,
  signUp,
  startStack,
  stopStack,
  waitForConsumer,
  waitForGateway,
  waitForInboxSize,
  waitForServiceReady,
} from './support/stack.js';

/**
 * AMQP subscriptions die with their channel; notification must reattach them
 * after reconnecting. A consuming-only service has no outbound calls or
 * Compose healthcheck to trigger recovery, so readiness must track subscriptions.
 * Exchange re-assertion is covered by messaging-lifecycle.spec.ts to avoid
 * wiping a running broker's volume.
 */
describe('Broker restart recovery', () => {
  beforeAll(async () => {
    startStack();
    await waitForGateway();
    await waitForServiceReady('identity');
    await waitForServiceReady('notification');
    await waitForConsumer(EMAIL_QUEUE);
  }, 1_200_000);

  afterAll(() => {
    stopStack();
  }, 300_000);

  it('re-attaches the consumer and delivers after RabbitMQ restarts', async () => {
    const run = `restart-${Date.now()}`;
    await clearMailpit();

    // Confirm delivery works before restarting the broker.
    expect((await signUp(`${run}-before@example.com`, 'en')).status).toBe(201);
    await waitForInboxSize(1);

    // Restart only RabbitMQ, not identity or notification.
    compose('restart', 'rabbitmq');

    // Check the broker's subscription count, not just connectivity.
    await waitForConsumer(EMAIL_QUEUE, 120_000);

    // Readiness must also reflect the restored consumer.
    await waitForServiceReady('notification', 120_000);

    // Exercise the relay's replacement confirm channel and notification delivery.
    expect((await signUp(`${run}-after@example.com`, 'en')).status).toBe(201);
    const inbox = await waitForInboxSize(2, 120_000);

    expect(inbox.total).toBeGreaterThanOrEqual(2);
    expect(
      inbox.messages.some((message) =>
        message.To.some(
          (recipient) => recipient.Address === `${run}-after@example.com`,
        ),
      ),
    ).toBe(true);
  }, 600_000);
});
