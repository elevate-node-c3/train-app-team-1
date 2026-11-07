import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

/** How a traveller searched: one way, or out and back. */
export type RecentSearchKindColumn = 'one_way' | 'round_trip';

/**
 * One search a traveller may want to repeat (BR-21).
 *
 * `account_id` deliberately carries no foreign key. Accounts live in identity's
 * database, and a cross-service constraint is what §2.3 forbids -- it would
 * couple catalog's schema to another service's lifecycle. The cost is that a
 * deleted account leaves rows behind, which is a cleanup job, not a correctness
 * problem: nothing can read them without that account's token.
 *
 * Both indexes are declared here as well as in the migration that creates them,
 * so a reader of the entity sees everything the table carries. The unique one is
 * load-bearing rather than defensive: it is what makes "at most five, without
 * duplicates" survive two concurrent writes, because the upsert needs a conflict
 * target and a read-then-write could not promise it.
 *
 * The relations to `station` and `travel_class` are columns rather than
 * `@ManyToOne` graphs on purpose. Nothing here navigates to a station object;
 * the read joins for names and drops entries whose station was deactivated, and
 * a row object that could reach into the station aggregate is exactly what the
 * boundary rules keep out.
 */
@Entity('recent_search')
@Unique('uq_recent_search_account_fingerprint', ['accountId', 'fingerprint'])
@Index('idx_recent_search_account_searched', ['accountId', 'searchedAt'])
export class RecentSearchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The signed-in traveller, from the verified token. Never client-supplied. */
  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  /**
   * What makes two searches "the same" (BR-21): route, class, kind and train
   * number. Dates are deliberately absent, so repeating a search with new dates
   * moves this row to the top instead of adding a sixth.
   */
  @Column({ type: 'text' })
  fingerprint!: string;

  @Column({ name: 'origin_station_id', type: 'uuid' })
  originStationId!: string;

  @Column({ name: 'destination_station_id', type: 'uuid' })
  destinationStationId!: string;

  @Column({ name: 'travel_class_id', type: 'uuid' })
  travelClassId!: string;

  @Column({ type: 'text' })
  kind!: RecentSearchKindColumn;

  /** Null means the traveller did not narrow by train. */
  @Column({ name: 'train_number', type: 'integer', nullable: true })
  trainNumber!: number | null;

  /**
   * Cairo civil dates, as `date` columns: these are calendar days a traveller
   * picked, not instants, and storing them as timestamps would invite a time
   * zone into a value that has none.
   */
  @Column({ name: 'departure_date', type: 'date', nullable: true })
  departureDate!: string | null;

  /** Null on a one-way search. */
  @Column({ name: 'return_date', type: 'date', nullable: true })
  returnDate!: string | null;

  /** When it was last run, which is what "newest first" orders by. */
  @Column({ name: 'searched_at', type: 'timestamptz' })
  searchedAt!: Date;
}
