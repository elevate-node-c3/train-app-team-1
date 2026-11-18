import { ErrorCode } from '@app/contracts';

/**
 * A hold business refusal. Transport adapters map the code to gRPC/HTTP;
 * repositories and the service never expose SQL or token details.
 */
export class HoldCoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly availableCount?: number,
    readonly passengerRef?: string,
  ) {
    super(message ?? code);
    this.name = 'HoldCoreError';
  }
}
