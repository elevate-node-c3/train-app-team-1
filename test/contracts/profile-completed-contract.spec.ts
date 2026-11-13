import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_REQUIRED_KEYS,
  PROFILE_COMPLETED_EVENT_TYPE,
  PROFILE_COMPLETED_PAYLOAD_KEYS,
  PROFILE_COMPLETED_VERSION,
  type EventEnvelope,
  type ProfileCompletedEvent,
  type ProfileCompletedPayloadV1,
} from '@app/contracts';
import {
  InvalidEventPayloadError,
  UnsupportedEventVersionError,
} from '@app/messaging/event-errors.js';
import { parseEventEnvelope } from '@app/messaging/consumer/parse-envelope.js';
import { buildProfileCompleted } from '../../apps/identity/src/modules/auth/identity-events.factory.js';
import { parseProfileCompletedPayload } from '../../apps/notification/src/modules/profile-completed/profile-completed.parser.js';

function buildEvent(): ProfileCompletedEvent {
  return buildProfileCompleted({
    eventId: '11111111-1111-4111-8111-111111111111',
    correlationId: '33333333-3333-4333-8333-333333333333',
    accountId: '22222222-2222-4222-8222-222222222222',
    fullName: 'Ahmed Hussein',
    occurredAt: new Date('2026-10-28T12:00:00.000Z'),
  });
}

function parseAsConsumer(event: unknown): ProfileCompletedPayloadV1 {
  const envelope: EventEnvelope = parseEventEnvelope(JSON.stringify(event), {
    type: PROFILE_COMPLETED_EVENT_TYPE,
    version: PROFILE_COMPLETED_VERSION,
  });
  return parseProfileCompletedPayload(envelope);
}

describe('ProfileCompleted event contract', () => {
  it('the consumer accepts the producer live output', () => {
    const event = buildEvent();
    expect(() => parseAsConsumer(event)).not.toThrow();
    expect(parseAsConsumer(event)).toEqual(event.payload);
  });

  it('the event carries exactly the required keys on both levels', () => {
    const event = buildEvent();
    expect(Object.keys(event).sort()).toEqual([...ENVELOPE_REQUIRED_KEYS].sort());
    expect(Object.keys(event.payload).sort()).toEqual(
      [...PROFILE_COMPLETED_PAYLOAD_KEYS].sort(),
    );
  });

  it.each([...ENVELOPE_REQUIRED_KEYS])(
    'the consumer rejects an event missing envelope field %s',
    (key) => {
      const incomplete = buildEvent() as unknown as Record<string, unknown>;
      delete incomplete[key];

      expect(() => parseAsConsumer(incomplete)).toThrow(
        InvalidEventPayloadError,
      );
    },
  );

  it.each([...PROFILE_COMPLETED_PAYLOAD_KEYS])(
    'the consumer rejects an event missing payload field %s',
    (key) => {
      const event = buildEvent();
      const incompletePayload = event.payload as unknown as Record<string, unknown>;
      delete incompletePayload[key];

      expect(() => parseAsConsumer(event)).toThrow(
        InvalidEventPayloadError,
      );
    },
  );

  it('rejects a version this build does not understand', () => {
    const event = buildEvent();
    event.version = PROFILE_COMPLETED_VERSION + 1;

    expect(() => parseAsConsumer(event)).toThrow(UnsupportedEventVersionError);
  });
});

