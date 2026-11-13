import {
  PROFILE_COMPLETED_PAYLOAD_KEYS,
  type EventEnvelope,
  type ProfileCompletedPayloadV1,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';

export function parseProfileCompletedPayload(
  envelope: EventEnvelope,
): ProfileCompletedPayloadV1 {
  const payload = envelope.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidEventPayloadError(
      'The profile-completed payload must be an object',
    );
  }

  const record = payload as Record<string, unknown>;
  for (const key of PROFILE_COMPLETED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new InvalidEventPayloadError(
        `The profile-completed payload is missing '${key}'`,
      );
    }
  }

  const accountId = nonEmptyString(record, 'accountId');
  const fullName = nonEmptyString(record, 'fullName');
  const completedAt = instant(record, 'completedAt');

  return {
    accountId,
    fullName,
    completedAt: completedAt.toISOString(),
  };
}

function nonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidEventPayloadError(
      `The profile-completed payload field '${key}' must be a non-empty string`,
    );
  }
  return value;
}

function instant(record: Record<string, unknown>, key: string): Date {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new InvalidEventPayloadError(
      `The profile-completed payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new InvalidEventPayloadError(
      `The profile-completed payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }
  return new Date(timestamp);
}
