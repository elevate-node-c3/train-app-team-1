import type { EventEnvelope } from '@app/contracts';
import { isEventEnvelope } from '@app/contracts';
import {
  InvalidEventPayloadError,
  UnsupportedEventVersionError,
} from '../event-errors.js';

/** Parse the envelope; keep payload validation and version routing separate. */
export function parseEventEnvelope(
  raw: Buffer | string,
  expected: { type: string; version: number },
): EventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch {
    // Never echo the raw body: it may contain a live verification code.
    throw new InvalidEventPayloadError('The event body is not valid JSON');
  }

  if (!isEventEnvelope(value)) {
    throw new InvalidEventPayloadError(
      'The event envelope is missing a required field',
    );
  }

  if (value.type !== expected.type) {
    throw new InvalidEventPayloadError(
      `Expected event type '${expected.type}', received '${value.type}'`,
    );
  }

  if (value.version !== expected.version) {
    throw new UnsupportedEventVersionError(value.version, expected.version);
  }

  return value;
}
