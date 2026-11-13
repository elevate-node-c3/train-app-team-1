import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Retain Idempotency keys permanently. Fingerprints distinguish retries from
 * changed bodies, and responseJson supplies the replay.
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
