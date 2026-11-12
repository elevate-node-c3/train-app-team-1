import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** The only two writes BR-52 covers so far. */
export type OperationsAction = 'timetable.published' | 'fare.changed';

/**
 * One operator action, forever (BR-52). Only ever written inside the caller's
 * transaction, and `trg_operations_audit_append_only` rejects UPDATE/DELETE.
 * `before`/`after` are snapshots; `before` is null on a first publish.
 */
@Entity('operations_audit')
@Index('idx_operations_audit_train_occurred', ['trainId', 'occurredAt'])
export class OperationsAuditEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  action!: OperationsAction;

  /** From the operator's verified token. */
  @Column({ name: 'actor_account_id', type: 'uuid' })
  actorAccountId!: string;

  @Column({ name: 'train_id', type: 'uuid' })
  trainId!: string;

  @Column({ type: 'jsonb', nullable: true })
  before!: unknown;

  @Column({ type: 'jsonb' })
  after!: unknown;

  /**
   * Always 0 this sprint: inventory has no seat tables yet, and append-only
   * rows mean the column must exist before them.
   */
  @Column({ name: 'tickets_affected', type: 'integer', default: 0 })
  ticketsAffected!: number;

  @Column({ name: 'correlation_id', type: 'text' })
  correlationId!: string;

  @Column({
    name: 'occurred_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  occurredAt!: Date;
}
