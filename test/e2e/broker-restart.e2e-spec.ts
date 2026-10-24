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
 * "Stop RabbitMQ, bring it back, and the email still arrives" — the demo the
 * event-backbone story names, with no service restarted by hand.
 *
 * `channel.consume` does not survive its channel, so notification used to come
 * back connected and deaf: the broker was reachable, `/health/ready` answered
 * `ready`, and no queue was being read. Nothing would have reached the AMQP
 * client again either, because a consuming-only service makes no outbound calls
 * after bootstrap and its container has no Compose healthcheck to poll.
 *
 * This spec covers recovery end to end. The exchange re-assertion half of the
 * same failure — a relay whose latched topology flag means a rebuilt broker
 * never gets `train.events` back — is pinned deterministically in
 * `messaging-lifecycle.spec.ts`, because reproducing it here would mean wiping
 * the broker's volume out from under running containers.
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

    // 1. Baseline, so a later failure cannot be blamed on a stack that never
    //    worked in the first place.
    expect((await signUp(`${run}-before@example.com`, 'en')).status).toBe(201);
    await waitForInboxSize(1);

    // 2. The broker goes away and comes back. Nothing else is touched: no
    //    `compose restart identity`, no `restart notification`.
    compose('restart', 'rabbitmq');

    // 3. The consumer count is the broker's own answer to "is anyone reading
    //    this queue", which is the assertion that would have failed before the
    //    client learned to redial and the consumer to re-subscribe.
    await waitForConsumer(EMAIL_QUEUE, 120_000);

    // 4. And readiness has to agree. It used to report `ready` on a live
    //    connection alone, which is what made the outage silent.
    await waitForServiceReady('notification', 120_000);

    // 5. The whole pipeline still works: identity's relay re-publishes over a
    //    replacement confirm channel and notification sends the mail.
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
