import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import type {
  OperationsAuditFilter,
  OperationsAuditPage,
} from './operations-audit.types.js';

/**
 * The append and the read, kept apart on purpose: `append` joins the
 * caller's transaction (BR-52 -- see the entity's doc comment), `list` never
 * does, because an operator reading the trail is not part of any write.
 */
@Injectable()
export class OperationsAuditRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Writes one row in `ctx`'s transaction. There is deliberately no overload
   * that opens its own: a publish or a fare change must commit together with
   * its record, or not at all.
   */
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
   * Newest first, optionally narrowed by train and date range, paged by a
   * cursor rather than an offset so a row inserted mid-list cannot shift a
   * later page.
   *
   * The cursor is the `id` of the last row the previous page returned.
   * `(occurred_at, id)` is the sort key -- `id` breaks a tie between two rows
   * sharing an instant, which `recent_search`'s trim already relies on for
   * the same reason. A cursor from a row that no longer exists (or never
   * did) matches nothing in the anchor subquery, so the page comes back
   * empty rather than guessing a position.
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

    // One extra row fetched, never returned: its presence is what tells us
    // whether a next page exists, without a separate COUNT(*).
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
