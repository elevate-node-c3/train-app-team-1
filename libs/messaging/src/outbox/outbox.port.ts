import type { EventEnvelope } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

/** Append in the caller's transaction so business and outbox writes cannot split. */
export const OUTBOX = Symbol('OUTBOX');

export interface OutboxPort {
  append(ctx: TransactionContext, envelope: EventEnvelope): Promise<void>;
}
