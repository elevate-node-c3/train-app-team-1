/**
 * Failure classification drives routing, so the distinction is in the type
 * system rather than in a string compared at the call site.
 *
 * Both subclasses are permanent — retrying either is forever wrong — but they
 * stay separate because `x-death-reason` drives replay: `invalid-payload` is a
 * producer bug and unreplayable, while `unsupported-version` becomes replayable
 * once the consumer that understands the version is deployed.
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
