import { VERIFICATION_CODE_ISSUED_EVENT_TYPE } from '@app/contracts';
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
 * Exercise messaging failure paths against the real Compose stack.
 * outbox-latency.e2e-spec.ts covers delivery; broker-restart.e2e-spec.ts
 * covers reconnecting and re-subscribing after a broker restart.
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

    // Broker acceptance while the consumer is down must not lose the event.
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
    // The consumer has no HTTP headers; English must come from the event.
    expect(inbox.messages[0].Subject).toBe('Your Train verification code');
  }, 180_000);

  it('demo 2: replaying the same event produces exactly one email', async () => {
    await clearMailpit();

    const email = `demo-2-${RUN}@example.com`;
    const result = await signUp(email, 'ar', `${RUN}-demo-2`);
    expect(result.status).toBe(201);
    await waitForInboxSize(1);

    // Code and account events share occurred_at; select verification-code.issued.
    // account.registered goes to another queue and sends no mail.
    const eventId = psql(
      'identity',
      `select id from outbox_event
        where event_type = '${VERIFICATION_CODE_ISSUED_EVENT_TYPE}'
        order by occurred_at desc limit 1`,
    );
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);

    // Re-arm the outbox row to republish the identical envelope and event ID.
    // Use broker delivery counts: handled claims do not increment attempt_count.
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

    // last_error must contain only the message, never the payload's live code.
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
