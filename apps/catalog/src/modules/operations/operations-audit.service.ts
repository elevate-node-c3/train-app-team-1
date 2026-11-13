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
  /** Null on a first publish. */
  before: unknown;
  /** Always present. */
  after: unknown;
  /** No inventory seat tables yet; currently always 0. */
  ticketsAffected: number;
  correlationId: string;
}

/** Append in the caller's transaction so changes and audit records commit together. */
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
