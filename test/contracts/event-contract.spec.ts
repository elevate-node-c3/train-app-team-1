import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_REQUIRED_KEYS,
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS,
  VERIFICATION_CODE_ISSUED_VERSION,
  type EventEnvelope,
  type VerificationCodeIssuedEvent,
  type VerificationCodeIssuedPayloadV1,
} from '@app/contracts';
import {
  InvalidEventPayloadError,
  UnsupportedEventVersionError,
} from '@app/messaging/event-errors.js';
import { parseEventEnvelope } from '@app/messaging/consumer/parse-envelope.js';
import { buildVerificationCodeIssued } from '../../apps/identity/src/modules/accounts/domain/events/verification-code-issued.factory.js';
import { parseVerificationCodeIssuedPayload } from '../../apps/notification/src/modules/verification-emails/application/verification-code-issued.parser.js';

/**
 * Consumer-driven contract test (ADR-0005).
 *
 * The two sides live in different services and never import each other. This
 * file is the only place they meet:
 *
 *   1. identity owns the builder below;
 *   2. notification owns the parser below — and it is the *same function* the
 *      running handler calls, so a test-only schema cannot drift from
 *      production;
 *   3. the golden sample is committed and was generated from the builder, not
 *      typed by hand.
 *
 * If the producer renames or drops a field a consumer needs, the deletion sweep
 * fails. If the consumer starts requiring a field the producer does not emit,
 * the golden sample stops parsing. Neither side can move alone.
 */

const GOLDEN_SAMPLE_PATH = join(
  process.cwd(),
  'test',
  'fixtures',
  'events',
  'verification-code-issued.v1.json',
);

const golden: VerificationCodeIssuedEvent = JSON.parse(
  readFileSync(GOLDEN_SAMPLE_PATH, 'utf8'),
) as VerificationCodeIssuedEvent;

/** Exactly the producer call the fixture was generated from. */
function buildEvent(): VerificationCodeIssuedEvent {
  return buildVerificationCodeIssued({
    eventId: '11111111-1111-4111-8111-111111111111',
    correlationId: '33333333-3333-4333-8333-333333333333',
    account: {
      id: '22222222-2222-4222-8222-222222222222',
      email: 'user@example.com',
      language: 'en',
    },
    code: '000000',
    purpose: 'sign_up',
    ttlSeconds: 600,
    issuedAt: new Date('2026-10-24T10:00:00.000Z'),
  });
}

/**
 * The consumer's real path: the envelope parser the runtime calls, followed by
 * the payload parser the handler calls. Testing only the payload parser would
 * leave every envelope field unguarded.
 */
function parseAsConsumer(event: unknown): VerificationCodeIssuedPayloadV1 {
  const envelope: EventEnvelope = parseEventEnvelope(JSON.stringify(event), {
    type: VERIFICATION_CODE_ISSUED_EVENT_TYPE,
    version: VERIFICATION_CODE_ISSUED_VERSION,
  });
  return parseVerificationCodeIssuedPayload(envelope);
}

function mutableClone(): VerificationCodeIssuedEvent {
  return structuredClone(golden);
}

describe('Producer/consumer event contract (ADR-0005)', () => {
  it('the committed golden sample is exactly what the producer builds', () => {
    // Any rename, removal or reordering of an emitted field turns this red,
    // and going green requires editing a committed file — a visible diff.
    expect(buildEvent()).toEqual(golden);
  });

  it("the consumer accepts the producer's live output", () => {
    expect(() => parseAsConsumer(buildEvent())).not.toThrow();
    expect(parseAsConsumer(buildEvent())).toEqual(buildEvent().payload);
  });

  it('the golden sample carries exactly the required keys on both levels', () => {
    // A guard against the required-key lists quietly shrinking until the
    // deletion sweep below is vacuous.
    expect(Object.keys(golden)).toEqual([...ENVELOPE_REQUIRED_KEYS]);
    expect(Object.keys(golden.payload)).toEqual([
      ...VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS,
    ]);
  });

  it.each([...ENVELOPE_REQUIRED_KEYS])(
    'the consumer rejects an event missing envelope field %s',
    (key) => {
      const incomplete: Record<string, unknown> = mutableClone();
      delete incomplete[key];

      expect(() => parseAsConsumer(incomplete)).toThrow(
        InvalidEventPayloadError,
      );
    },
  );

  it.each([...VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS])(
    'the consumer rejects an event missing payload field %s',
    (key) => {
      const incomplete = mutableClone();
      delete (incomplete.payload as Record<string, unknown>)[key];

      expect(() => parseAsConsumer(incomplete)).toThrow(
        InvalidEventPayloadError,
      );
    },
  );

  it('accepts additive fields on both levels without a version bump', () => {
    const event = mutableClone() as VerificationCodeIssuedEvent &
      Record<string, unknown>;
    event.futureEnvelopeField = 'ignored';
    (event.payload as Record<string, unknown>).futurePayloadField = 'ignored';

    expect(parseAsConsumer(event).code).toBe(golden.payload.code);
  });

  it('coerces an unknown language to Arabic rather than dead-lettering', () => {
    const event = mutableClone();
    (event.payload as Record<string, unknown>).language = 'fr';

    expect(parseAsConsumer(event).language).toBe('ar');
  });

  it('parses a code whose expiry has already passed', () => {
    // Expiry is a handling decision, not a contract violation: failing the
    // parse would send recoverable traffic to the DLQ (ADR-0005).
    const event = mutableClone();
    event.payload.issuedAt = '2020-01-01T00:00:00.000Z';
    event.payload.expiresAt = '2020-01-01T00:10:00.000Z';

    expect(parseAsConsumer(event).expiresAt).toBe('2020-01-01T00:10:00.000Z');
  });

  it('rejects a version this build does not understand', () => {
    const event = mutableClone() as VerificationCodeIssuedEvent;
    event.version = VERIFICATION_CODE_ISSUED_VERSION + 1;

    expect(() => parseAsConsumer(event)).toThrow(UnsupportedEventVersionError);
  });
});
