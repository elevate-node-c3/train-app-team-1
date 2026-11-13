/** Claim in one call so two workers cannot both observe an unhandled event. */
export const PROCESSED_EVENT_STORE = Symbol('PROCESSED_EVENT_STORE');

export interface ClaimEvent {
  eventId: string;
  eventType: string;
  /** True when the previous channel closed before acknowledgment. */
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
