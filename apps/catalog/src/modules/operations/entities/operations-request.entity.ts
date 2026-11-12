import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One `Idempotency-Key`, forever (TA-20). `fingerprint` separates a genuine
 * retry from a reused key on different content; `responseJson` is the replay.
 */
@Entity('operations_request')
export class OperationsRequestEntity {
  @PrimaryColumn({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({ type: 'text' })
  fingerprint!: string;

  @Column({ name: 'response_json', type: 'jsonb' })
  responseJson!: string;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;
}
