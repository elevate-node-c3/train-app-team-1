import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('hold_passenger_trip_key')
export class HoldPassengerTripKeyEntity {
  @PrimaryColumn({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'key_version', type: 'integer' })
  keyVersion!: number;

  @Column({ name: 'key_fingerprint', type: 'text' })
  keyFingerprint!: string;

  @Column({ name: 'pinned_at', type: 'timestamptz' })
  pinnedAt!: Date;
}
