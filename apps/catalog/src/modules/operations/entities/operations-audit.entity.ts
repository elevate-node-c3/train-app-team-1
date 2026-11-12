import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** The only two writes BR-52 currently asks this trail to cover. */
export type OperationsAction = 'timetable.published' | 'fare.changed';

/**
 * One operator action, forever. BR-52: no change without its record, no
 * record without its change -- `OperationsAuditService.append` only ever
 * writes this row inside the caller's own transaction, so the two commit or
 * roll back together. The database's own `trg_operations_audit_append_only`
 * trigger (migration 1793300000007) is what makes "forever" a fact rather
 * than a habit: an `UPDATE` or `DELETE` against this table is rejected, full
 * stop.
 *
 * `before`/`after` are snapshots of the changed thing, not a computed diff --
 * a snapshot cannot become wrong later if the diff format changes.
 * `before` is null on a first publish, when there is nothing to compare to.
 */
@Entity('operations_audit')
@Index('idx_operations_audit_train_occurred', ['trainId', 'occurredAt'])
export class OperationsAuditEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  action!: OperationsAction;

  /** The operator who made the change, from their verified token. */
  @Column({ name: 'actor_account_id', type: 'uuid' })
  actorAccountId!: string;

  @Column({ name: 'train_id', type: 'uuid' })
  trainId!: string;

  @Column({ type: 'jsonb', nullable: true })
  before!: unknown;

  @Column({ type: 'jsonb' })
  after!: unknown;

  /**
   * Always 0 this sprint -- inventory has no seat tables yet. The column
   * exists now because this table cannot be altered by UPDATE once rows
   * exist, only a fresh migration's default would reach future inserts.
   */
  @Column({ name: 'tickets_affected', type: 'integer', default: 0 })
  ticketsAffected!: number;

  /** Ties this row to the request that caused it. */
  @Column({ name: 'correlation_id', type: 'text' })
  correlationId!: string;

  @Column({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  occurredAt!: Date;
}
