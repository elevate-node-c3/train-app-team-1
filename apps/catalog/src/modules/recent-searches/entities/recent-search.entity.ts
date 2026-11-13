import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

export type RecentSearchKindColumn = 'one_way' | 'round_trip';

/**
 * Accounts belong to identity, so account_id has no cross-service foreign key.
 * Deleted accounts leave rows for cleanup; reads still require that account's token.
 * Mirror migration indexes; account/fingerprint uniqueness supports atomic deduplication.
 * Keep station/class references as columns, not aggregate navigation. Reads join
 * names and omit inactive stations.
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
   * Route, class, kind, and train number define identity, not dates.
   * Repeating with new dates refreshes the row instead of adding another entry.
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

  /** Cairo calendar days, not timestamps; timezone conversion must not shift them. */
  @Column({ name: 'departure_date', type: 'date', nullable: true })
  departureDate!: string | null;

  /** Null on a one-way search. */
  @Column({ name: 'return_date', type: 'date', nullable: true })
  returnDate!: string | null;

  /** Last run time for newest-first order. */
  @Column({ name: 'searched_at', type: 'timestamptz' })
  searchedAt!: Date;
}
