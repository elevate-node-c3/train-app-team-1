import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';

import { SeatHoldGroupEntity } from './seat-hold-group.entity.js';

/** Passenger token/version snapshot for one hold, never exposed in responses. */
@Entity('seat_hold_passenger')
@Index('uq_seat_hold_passenger_ref', ['holdId', 'tripId', 'passengerRef'], {
  unique: true,
})
@Check(
  'chk_seat_hold_passenger_key_version',
  `"passenger_key_version" > 0`,
)
export class SeatHoldPassengerEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'hold_id', type: 'uuid' })
  holdId!: string;

  @ManyToOne(() => SeatHoldGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hold_id' })
  hold?: Relation<SeatHoldGroupEntity>;

  /** Identity tokens are trip-scoped, so one passenger has one row per leg. */
  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'passenger_ref', type: 'text' })
  passengerRef!: string;

  @Column({ name: 'passenger_token', type: 'text' })
  passengerToken!: string;

  @Column({ name: 'passenger_key_version', type: 'integer' })
  passengerKeyVersion!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
