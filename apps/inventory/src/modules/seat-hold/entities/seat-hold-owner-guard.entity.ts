import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One lock row per traveller. Create transactions lock it before reading the
 * active hold so two sessions for the same owner serialize deterministically.
 */
@Entity('seat_hold_owner_guard')
export class SeatHoldOwnerGuardEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
