import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_QUEUE,
  clearMailpit,
  compose,
  deliveredCount,
  mailpitInbox,
  psql,
  queueStats,
  signUp,
  startStack,
  stopStack,
  waitFor,
  waitForConsumer,
  waitForGateway,
  waitForInboxSize,
  waitForServiceReady,
} from './support/stack.js';

/**
 * The three review demos from the README's "Unhappy Demo Paths", run
 * non-interactively against the real Compose stack.
 *
 * Each demo proves one failure mode of the backbone rather than the happy
 * path, which the latency spec covers.
 *
 * Demo 1b stops the broker. That used to make the order load-bearing, because
 * the consumer never re-subscribed afterwards and every later demo would have
 * found a deaf notification; the client now redials and the consumer
 * re-attaches, which `broker-restart.e2e-spec.ts` covers directly.
 */

const RUN = `${Date.now()}`;

describe('Outbox event backbone demos', () => {
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

  it('demo 1: a sign-up survives a stopped consumer and emails on restart', async () => {
    await clearMailpit();
    compose('stop', 'notification');

    const email = `demo-1-${RUN}@example.com`;
    const result = await signUp(email, 'en', `${RUN}-demo-1`);

    expect(result.status).toBe(201);
    console.log(
      `demo 1: sign-up answered ${result.status} in ${result.elapsedMs}ms with notification stopped`,
    );

    // The relay is still running: the broker accepted the publish while the
    // consumer was down, so the outage is not a data-loss window.
    await waitFor(
      'the outbox row to be published while notification is stopped',
      () =>
        psql(
          'identity',
          'select published_at is not null from outbox_event order by occurred_at desc limit 1',
        ) === 't',
      30_000,
    );

    await waitFor(
      'the event to be parked on the durable queue',
      async () => (await queueStats(EMAIL_QUEUE)).messages >= 1,
      30_000,
    );

    compose('start', 'notification');

    const inbox = await waitForInboxSize(1);
    expect(inbox.messages[0].To[0].Address).toBe(email);
    // English proves the account's language travelled in the event: there is no
    // HTTP request on the consumer side to read Accept-Language from.
    expect(inbox.messages[0].Subject).toBe('Your Train verification code');
  }, 180_000);

  it('demo 2: replaying the same event produces exactly one email', async () => {
    await clearMailpit();

    const email = `demo-2-${RUN}@example.com`;
    const result = await signUp(email, 'ar', `${RUN}-demo-2`);
    expect(result.status).toBe(201);
    await waitForInboxSize(1);

    const eventId = psql(
      'identity',
      'select id from outbox_event order by occurred_at desc limit 1',
    );
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);

    // A real duplicate: re-arming the row makes the relay republish the
    // byte-identical envelope with the same id, exactly as a crashed relay
    // would. Delivery is measured through the broker's own counter because a
    // handled row is refused a claim and never increments attempt_count.
    const before = deliveredCount(await queueStats(EMAIL_QUEUE));

    psql(
      'identity',
      `update outbox_event set published_at = null, next_attempt_at = now() where id = '${eventId}'`,
    );

    await waitFor(
      'the relay to republish the same envelope',
      () =>
        psql(
          'identity',
          `select published_at is not null from outbox_event where id = '${eventId}'`,
        ) === 't',
      30_000,
    );

    await waitFor(
      'the duplicate delivery to reach the consumer',
      async () => deliveredCount(await queueStats(EMAIL_QUEUE)) > before,
      60_000,
    );
    await waitFor(
      'the consumer to ack the duplicate',
      async () => (await queueStats(EMAIL_QUEUE)).messages === 0,
      30_000,
    );

    expect((await mailpitInbox()).total).toBe(1);
    expect(
      psql(
        'notification',
        `select status from processed_event where event_id = '${eventId}'`,
      ),
    ).toBe('handled');
    expect(
      psql(
        'notification',
        `select attempt_count from processed_event where event_id = '${eventId}'`,
      ),
    ).toBe('1');
  }, 180_000);

  it('demo 1b: a sign-up survives a stopped broker and publishes on recovery', async () => {
    compose('stop', 'rabbitmq');

    const result = await signUp(
      `demo-1b-${RUN}@example.com`,
      'ar',
      `${RUN}-demo-1b`,
    );
    expect(result.status).toBe(201);
    console.log(
      `demo 1b: sign-up answered ${result.status} in ${result.elapsedMs}ms with the broker stopped`,
    );

    // `last_error` holds the error message only; the payload's live code is
    // never copied into a column operators read.
    await waitFor(
      'the relay to record a broker failure',
      () => {
        const row = psql(
          'identity',
          "select published_at is not null, attempt_count, coalesce(last_error, '') from outbox_event order by occurred_at desc limit 1",
        );
        const [published, attempts, lastError] = row.split('|');
        return (
          published === 'f' &&
          Number.parseInt(attempts, 10) > 0 &&
          lastError.length > 0
        );
      },
      90_000,
    );

    compose('start', 'rabbitmq');

    await waitFor(
      'the outbox row to publish after the broker recovers',
      () =>
        psql(
          'identity',
          'select published_at is not null from outbox_event order by occurred_at desc limit 1',
        ) === 't',
      120_000,
    );
  }, 240_000);
});
