import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Only timetable publication and fare changes are audited so far. */
export type OperationsAction = 'timetable.published' | 'fare.changed';

/**
 * Retain actions permanently; append in the caller's transaction. The database
 * rejects UPDATE/DELETE. before/after are snapshots; before is null on first publication.
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

  /** No inventory seat tables yet; this append-only field is currently always 0. */
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
