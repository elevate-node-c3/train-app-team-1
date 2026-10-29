/**
 * The consumer's idempotency guard, as the application layer sees it.
 *
 * `claim` is one round trip by contract: a `SELECT` followed by an `INSERT`
 * lets two instances both observe "not handled" and both send. The store's
 * implementation puts the race in a single `INSERT ... ON CONFLICT`.
 */
export const PROCESSED_EVENT_STORE = Symbol('PROCESSED_EVENT_STORE');

export interface ClaimEvent {
  eventId: string;
  eventType: string;
  /** `msg.fields.redelivered`: true means a channel closed unacked. */
  redelivered: boolean;
  leaseSeconds: number;
}

export interface ProcessedEventStorePort {
  /** The attempt number (1-based) if this caller won the claim, else null. */
  claim(event: ClaimEvent): Promise<number | null>;
  markHandled(eventId: string): Promise<void>;
  markSkipped(eventId: string, skipReason: string): Promise<void>;
  markFailed(eventId: string, errorMessage: string): Promise<void>;
}
