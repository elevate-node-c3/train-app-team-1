import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';
import type { SeatUsageForTripsRequest } from '@app/contracts';

/**
 * A publish checks every trip a timetable change would touch, which is one
 * trip per service date in the booking window, so the cap is generous. It
 * exists so one request cannot ask for an unbounded IN list.
 */
const MAX_TRIP_IDS = 500;

/**
 * Catalog asks how many seats are sold or held before it rewrites a trip, so
 * every id reaches a uuid column in the usage query.
 *
 * The list may be empty: a publish whose diff touches no existing trip asks
 * about nothing, and gets an empty answer. Duplicates are allowed too -- the
 * query groups by trip, so deduplicating would be the caller's busywork.
 */
export class SeatUsageForTripsRequestDto implements SeatUsageForTripsRequest {
  @IsArray()
  @ArrayMaxSize(MAX_TRIP_IDS)
  @IsUUID(undefined, { each: true })
  tripIds!: string[];
}
