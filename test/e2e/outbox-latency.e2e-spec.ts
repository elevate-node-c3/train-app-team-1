import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_QUEUE,
  clearMailpit,
  mailpitInbox,
  psql,
  signUp,
  startStack,
  stopStack,
  waitFor,
  waitForConsumer,
  waitForGateway,
  waitForServiceReady,
} from './support/stack.js';

/**
 * BR-03 is a build gate: OTP delivery within 30 seconds, measured from the
 * payload's `issuedAt` (stamped inside identity's transaction) to
 * `accepted_at` (taken after Mailpit answers SMTP 250).
 *
 * The latency is read from notification's `email_delivery` rows, not from the
 * HTTP response. The sign-up response is deliberately independent of delivery;
 * timing it would measure the wrong thing.
 */

const SIGNUPS = 25;
const BUDGET_MS = 30_000;

const LATENCY_SQL =
  "select count(*), coalesce(percentile_cont(0.50) within group (order by latency_ms)::int, 0), coalesce(percentile_cont(0.95) within group (order by latency_ms)::int, 0), coalesce(max(latency_ms), 0) from email_delivery where outcome = 'accepted'";

describe('BR-03 OTP delivery latency', () => {
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

  it(`delivers ${SIGNUPS} codes within the ${BUDGET_MS}ms budget`, async () => {
    await clearMailpit();

    const run = `lat-${Date.now()}`;
    for (let index = 1; index <= SIGNUPS; index += 1) {
      const result = await signUp(
        `${run}-${index}@example.com`,
        'en',
        `${run}-${index}`,
      );
      expect(result.status).toBe(201);
    }

    await waitFor(
      `all ${SIGNUPS} deliveries to be accepted`,
      () =>
        Number(
          psql(
            'notification',
            "select count(*) from email_delivery where outcome = 'accepted'",
          ),
        ) === SIGNUPS,
      120_000,
    );

    const [sent, p50, p95, worst] = psql('notification', LATENCY_SQL)
      .split('|')
      .map(Number);

    console.log(
      `BR-03 latency: sent=${sent} p50=${p50}ms p95=${p95}ms worst=${worst}ms`,
    );

    expect(sent).toBe(SIGNUPS);
    expect(p95).toBeLessThan(BUDGET_MS);
    expect(worst).toBeLessThan(BUDGET_MS);

    // The DB rows prove what the handler recorded; the inbox proves the mail
    // actually left the process. A clean run has no skipped or failed rows.
    expect((await mailpitInbox()).total).toBe(SIGNUPS);
    expect(
      psql(
        'notification',
        "select count(*) from email_delivery where outcome <> 'accepted'",
      ),
    ).toBe('0');
  }, 240_000);
});
