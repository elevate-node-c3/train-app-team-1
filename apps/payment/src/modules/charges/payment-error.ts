import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

/**
 * A charge refusal. The service names the code and nothing else: the status is
 * the controller's, and the text is the edge's, in the caller's language.
 */
export class PaymentError extends Error {
  readonly details: ValidationIssueRef[] = [];

  constructor(
    readonly code: ErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'PaymentError';
  }
}
