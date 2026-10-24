import type { EventEnvelope } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

/**
 * The application layer's view of the outbox. `append` takes the caller's
 * transaction context and nothing else: there is no method that opens its own
 * transaction, so the outbox row and the business change cannot be split
 * (ADR-0001).
 */
export const OUTBOX = Symbol('OUTBOX');

export interface OutboxPort {
  append(ctx: TransactionContext, envelope: EventEnvelope): Promise<void>;
}
