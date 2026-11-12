import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One `Idempotency-Key` a client has sent, forever (TA-20). `fingerprint`
 * tells a genuine retry (same key, same content) apart from a reused key on
 * different content, which is a client bug rather than a replay.
 * `responseJson` is what a genuine retry gets back instead of redoing the
 * write.
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
