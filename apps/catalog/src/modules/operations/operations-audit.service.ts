import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import type {
  OperationsAction,
  OperationsAuditEntity,
} from './entities/operations-audit.entity.js';
import { OperationsAuditRepository } from './operations-audit.repository.js';
import type {
  OperationsAuditFilter,
  OperationsAuditPage,
} from './operations-audit.types.js';

export interface AppendAuditInput {
  action: OperationsAction;
  actorAccountId: string;
  trainId: string;
  /** A snapshot, null on a first publish. */
  before: unknown;
  /** A snapshot, always present. */
  after: unknown;
  /** 0 this sprint; the column exists ahead of inventory having seats. */
  ticketsAffected: number;
  correlationId: string;
}

/**
 * BR-52's trail. `append` is the half of the contract that matters most: it
 * takes the caller's `TransactionContext` and nothing else, so a publish or
 * a fare change can never commit without its record, or roll back leaving
 * one behind. There is no overload that opens its own transaction -- the
 * same shape as `OutboxPort.append`, for the same reason.
 */
@Injectable()
export class OperationsAuditService {
  constructor(private readonly repository: OperationsAuditRepository) {}

  async append(
    ctx: TransactionContext,
    input: AppendAuditInput,
  ): Promise<OperationsAuditEntity> {
    const entity: OperationsAuditEntity = {
      id: randomUUID(),
      action: input.action,
      actorAccountId: input.actorAccountId,
      trainId: input.trainId,
      before: input.before,
      after: input.after,
      ticketsAffected: input.ticketsAffected,
      correlationId: input.correlationId,
      occurredAt: new Date(),
    };

    return this.repository.append(ctx, entity);
  }

  async list(filter: OperationsAuditFilter): Promise<OperationsAuditPage> {
    return this.repository.list(filter);
  }
}
