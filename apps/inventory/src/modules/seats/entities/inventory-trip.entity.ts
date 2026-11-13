import { Check, Column, Entity, OneToMany, PrimaryColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import type { TripStopEntity } from './trip-stop.entity.js';
import type { TripCoachEntity } from './trip-coach.entity.js';

/** Id is catalog's dated trip id; inventory never joins back to catalog's database. */
@Entity('inventory_trip')
@Check('chk_inventory_trip_status', `"status" IN ('on_sale', 'closed')`)
export class InventoryTripEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: 'on_sale' | 'closed';

  // Guards republication: a lower or equal version never overwrites this row.
  @Column({ name: 'timetable_version', type: 'integer' })
  timetableVersion!: number;

  // Children import this file for their owning @ManyToOne; naming the target
  // here instead of importing it keeps the runtime graph acyclic.
  @OneToMany('TripStopEntity', 'trip')
  stops!: Relation<TripStopEntity[]>;

  @OneToMany('TripCoachEntity', 'trip')
  coaches!: Relation<TripCoachEntity[]>;
}
