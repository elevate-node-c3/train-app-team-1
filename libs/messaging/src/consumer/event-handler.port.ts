import type { EventEnvelope } from '@app/contracts';

export interface EventHandlingResult {
  status: 'handled' | 'skipped';
  /** Recorded verbatim in `processed_event.skip_reason`. */
  skipReason?: string;
}

/**
 * A handler is the consumer's business logic. It runs only after the claim was
 * won and may throw:
 * - a `PermanentEventError` dead-letters immediately;
 * - anything else is transient and enters the retry topology.
 */
export interface EventHandlerPort {
  handle(
    envelope: EventEnvelope,
    attempt: number,
  ): Promise<EventHandlingResult>;
}
