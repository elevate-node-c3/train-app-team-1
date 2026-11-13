import type { EventEnvelope } from '@app/contracts';

export interface EventHandlingResult {
  status: 'handled' | 'skipped';
  /** Recorded verbatim in `processed_event.skip_reason`. */
  skipReason?: string;
}

/**
 * Run business logic only after winning the event claim.
 * PermanentEventError dead-letters; other errors enter retries.
 */
export interface EventHandlerPort {
  handle(
    envelope: EventEnvelope,
    attempt: number,
  ): Promise<EventHandlingResult>;
}
