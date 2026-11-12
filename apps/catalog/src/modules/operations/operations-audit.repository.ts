import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import type {
  OperationsAuditFilter,
  OperationsAuditPage,
} from './operations-audit.types.js';

/** BR-52's trail: `append` joins the caller's transaction, `list` never does. */
@Injectable()
export class OperationsAuditRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Writes in `ctx`'s transaction; there is no self-opening overload. */
  async append(
    ctx: TransactionContext,
    entity: OperationsAuditEntity,
  ): Promise<OperationsAuditEntity> {
    const repository = entityManagerOf(ctx).getRepository(
      OperationsAuditEntity,
    );
    return repository.save(entity);
  }

  /**
   * Newest first, paged by `(occurred_at, id)` so an insert mid-list cannot
   * shift a later page. An unknown cursor matches nothing and returns an empty
   * page.
   */
  async list(filter: OperationsAuditFilter): Promise<OperationsAuditPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const push = (fragment: string, value: unknown): void => {
      params.push(value);
      conditions.push(fragment.replace('?', `$${params.length}`));
    };

    if (filter.trainId) {
      push('a.train_id = ?', filter.trainId);
    }
    if (filter.from) {
      push('a.occurred_at >= ?', filter.from);
    }
    if (filter.to) {
      push('a.occurred_at <= ?', filter.to);
    }
    if (filter.cursor) {
      push(
        `(a.occurred_at, a.id) < (
           SELECT occurred_at, id FROM "operations_audit" WHERE id = ?
         )`,
        filter.cursor,
      );
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // One extra row, never returned, tells us whether a next page exists.
    params.push(filter.limit + 1);
    const limitParam = `$${params.length}`;

    const rows: RawAuditRow[] = await this.dataSource.query(
      `SELECT id, action, actor_account_id, train_id, before, after,
              tickets_affected, correlation_id, occurred_at
         FROM "operations_audit" a
         ${where}
         ORDER BY a.occurred_at DESC, a.id DESC
         LIMIT ${limitParam}`,
      params,
    );

    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;

    return {
      entries: page.map(fromRow),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}

interface RawAuditRow {
  id: string;
  action: string;
  actor_account_id: string;
  train_id: string;
  before: unknown;
  after: unknown;
  tickets_affected: number;
  correlation_id: string;
  occurred_at: Date;
}

function fromRow(row: RawAuditRow): OperationsAuditEntity {
  const entity = new OperationsAuditEntity();
  entity.id = row.id;
  entity.action = row.action as OperationsAuditEntity['action'];
  entity.actorAccountId = row.actor_account_id;
  entity.trainId = row.train_id;
  entity.before = row.before;
  entity.after = row.after;
  entity.ticketsAffected = Number(row.tickets_affected);
  entity.correlationId = row.correlation_id;
  entity.occurredAt = row.occurred_at;
  return entity;
}
