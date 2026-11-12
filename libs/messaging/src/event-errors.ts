/**
 * Both errors dead-letter without retry; their reason controls replay.
 * Invalid payloads cannot replay; unsupported versions can after a consumer update.
 */
export type PermanentEventReason = 'invalid-payload' | 'unsupported-version';

export class PermanentEventError extends Error {
  constructor(
    message: string,
    readonly reason: PermanentEventReason,
  ) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

export class InvalidEventPayloadError extends PermanentEventError {
  constructor(message = 'The event payload is invalid') {
    super(message, 'invalid-payload');
    this.name = 'InvalidEventPayloadError';
  }
}

export class UnsupportedEventVersionError extends PermanentEventError {
  constructor(
    readonly receivedVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Unsupported event version ${receivedVersion}; this consumer supports ${supportedVersion}`,
      'unsupported-version',
    );
    this.name = 'UnsupportedEventVersionError';
  }
}

export function isPermanentEventError(
  error: unknown,
): error is PermanentEventError {
  return error instanceof PermanentEventError;
}
