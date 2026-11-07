import { Injectable, Logger } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  ErrorCode,
  FARE_CURRENCY,
  bookingWindowFor,
  civilDateTimeOf,
  durationMinutesBetween,
  type FilterOptions,
  type SearchOneWayTripsRequest,
  type SearchOneWayTripsResponse,
  type TripResult,
} from '@app/contracts';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { CatalogSearchError } from './catalog-search-error.js';
import { buildDateStrip } from './date-strip.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripSearchRepository } from './trip-search.repository.js';
import {
  cacheTtlSecondsFor,
  isCachedStaticTrip,
  searchCacheKey,
  type CachedStaticTrip,
} from './trip-search-cache.js';
import { emptyReasonFor } from './trip-search-empty-reason.js';
import {
  applyFilters,
  filterOptionsFor,
  validateFilters,
} from './trip-search-filters.js';
import { sortTrips } from './trip-search-sort.js';
import {
  validateSearchReferences,
  validateSearchShape,
} from './trip-search-validation.js';
import { applyDynamicEligibility } from './trip-sellability.js';
import type { TripSearchRow } from './trip-search.types.js';

/**
 * One-way search.
 *
 * The order of the steps below is the design. Two of them are load-bearing:
 *
 * `now` is captured once by the caller and threaded through everything. The
 * window, the strip, the validator, the day range and the eligibility filter
 * must all agree about what time it is, or a response can contradict itself --
 * a strip that offers a date the validator would refuse, for instance.
 *
 * Eligibility is applied after the cache read, on the hit path and the miss
 * path alike. That is what makes "a list cached at 13:50 must not offer, at
 * 14:00, a trip whose sales closed at 13:55" a property of the code rather
 * than a thing to remember: there is only one path, and the cached payload
 * holds nothing about sales state to go stale.
 *
 * Read-only throughout (TA-33): no events, no outbox rows, no writes. The
 * temptation to publish "a search was performed" for analytics is exactly what
 * this resists -- it would turn the most frequent read in the system into a
 * write.
 */
@Injectable()
export class TripSearchService {
  private readonly logger = new Logger(TripSearchService.name);

  constructor(
    private readonly trips: TripSearchRepository,
    private readonly references: CatalogReferenceRepository,
    private readonly availability: SeatAvailabilityService,
    private readonly cache: CacheAsideService,
  ) {}

  async search(
    request: SearchOneWayTripsRequest,
    now: Date,
  ): Promise<SearchOneWayTripsResponse> {
    const bookingWindow = bookingWindowFor(now);
    const dateStrip = buildDateStrip(request.departureDate, now);

    await this.refuseInvalid(request, now);

    const trainNumber = request.trainNumber ?? null;
    const statics = await this.staticTrips(request, trainNumber, now);

    // Hit or miss, the same filter, so a cached list cannot outlive the sales
    // it was cached with.
    const eligible = applyDynamicEligibility(statics, now);

    // Facets describe the day before the request's own filters, so narrowing
    // never hides the choices needed to undo the narrowing.
    const filterOptions = filterOptionsFor(eligible);

    // One batched call for every segment at once.
    const seats = await this.availability.availabilityFor(
      eligible.map((trip) => ({
        tripId: trip.tripId,
        originStationId: trip.originStationId,
        destinationStationId: trip.destinationStationId,
        travelClassId: request.travelClassId,
        classCapacity: trip.classCapacity,
      })),
    );

    // The availability call the response already needs answers the sold-out
    // filter too, so applying it adds no query.
    const soldOutTripIds = new Set(
      eligible
        .filter((trip) => (seats.get(trip.tripId) ?? 0) === 0)
        .map((trip) => trip.tripId),
    );

    const filtered = applyFilters(eligible, request.filters, soldOutTripIds);

    const trips = sortTrips(
      filtered.filter((trip) => this.isSellable(trip)),
      request.sort,
    ).map((trip) => this.toTripResult(trip, request, seats));

    return {
      dateStrip,
      trips,
      bookingWindow,
      evaluatedAt: civilDateTimeOf(now),
      filterOptions,
      ...(trips.length === 0
        ? {
            emptyResult: await this.explainEmpty(
              request,
              trainNumber,
              filterOptions,
              eligible.length > 0 && filtered.length === 0,
            ),
          }
        : {}),
    };
  }

  /** Shape first, then the catalogue, so an obvious refusal costs no queries. */
  private async refuseInvalid(
    request: SearchOneWayTripsRequest,
    now: Date,
  ): Promise<void> {
    const shapeDetails = [
      ...validateSearchShape(request, now),
      ...validateFilters(request.filters),
    ];
    if (shapeDetails.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, shapeDetails);
    }

    const facts = await this.references.resolveReferences({
      stationIds: [request.originStationId, request.destinationStationId],
      travelClassId: request.travelClassId,
      trainNumber: request.trainNumber ?? null,
    });

    const referenceDetails = validateSearchReferences(request, facts);
    if (referenceDetails.length > 0) {
      throw new CatalogSearchError(
        ErrorCode.VALIDATION_ERROR,
        referenceDetails,
      );
    }
  }

  /**
   * The static projection, from the cache when it is there and from Postgres
   * when it is not.
   *
   * A cached entry that does not match the current shape is treated as a miss:
   * it parses as JSON and would otherwise put `undefined` into a traveller's
   * results.
   */
  private async staticTrips(
    request: SearchOneWayTripsRequest,
    trainNumber: number | null,
    now: Date,
  ): Promise<CachedStaticTrip[]> {
    const key = searchCacheKey({
      originStationId: request.originStationId,
      destinationStationId: request.destinationStationId,
      serviceDate: request.departureDate,
      travelClassId: request.travelClassId,
      trainNumber,
    });

    const cached = await this.cache.get<unknown[]>(key);
    if (Array.isArray(cached) && cached.every(isCachedStaticTrip)) {
      return cached;
    }

    const rows = await this.trips.findCandidates({
      originStationId: request.originStationId,
      destinationStationId: request.destinationStationId,
      travelClassId: request.travelClassId,
      serviceDate: request.departureDate,
      trainNumber,
      now,
    });

    const statics = rows.map((row) => this.toStatic(row));
    await this.cache.set(
      key,
      statics,
      cacheTtlSecondsFor(request.departureDate, now),
    );

    return statics;
  }

  /**
   * A row becomes its cacheable projection.
   *
   * The duration is computed here, from the two instants, so it is right
   * across midnight and across a daylight-saving change -- and so it is
   * computed once rather than on every cache read.
   */
  private toStatic(row: TripSearchRow): CachedStaticTrip {
    return {
      tripId: row.tripId,
      trainNumber: row.trainNumber,
      trainTypeId: row.trainTypeId,
      trainTypeEn: row.trainTypeEn,
      trainTypeAr: row.trainTypeAr,
      travelClassNameEn: row.travelClassNameEn,
      travelClassNameAr: row.travelClassNameAr,
      originStationId: row.originStationId,
      originNameEn: row.originNameEn,
      originNameAr: row.originNameAr,
      destinationStationId: row.destinationStationId,
      destinationNameEn: row.destinationNameEn,
      destinationNameAr: row.destinationNameAr,
      originDepartureMillis: row.originDepartureAt.getTime(),
      destinationArrivalMillis: row.destinationArrivalAt.getTime(),
      durationMinutes: durationMinutesBetween(
        row.originDepartureAt,
        row.destinationArrivalAt,
      ),
      intermediateStops: row.intermediateStops,
      classCapacity: row.classCapacity,
      farePiastres: row.farePiastres,
    };
  }

  /**
   * A trip with no fare for the segment cannot be booked, so offering it would
   * strand the traveller one screen later. Logged, because a sellable trip
   * without a price is a data gap someone should fix rather than a normal
   * state.
   */
  private isSellable(trip: CachedStaticTrip): boolean {
    if (trip.farePiastres === null) {
      this.logger.warn(
        `Trip ${trip.tripId} has no fare for ${trip.originStationId} -> ${trip.destinationStationId}; excluded from search`,
      );
      return false;
    }
    return true;
  }

  private toTripResult(
    trip: CachedStaticTrip,
    request: SearchOneWayTripsRequest,
    seats: Map<string, number>,
  ): TripResult {
    const availableSeats = seats.get(trip.tripId) ?? 0;

    return {
      tripId: trip.tripId,
      trainNumber: trip.trainNumber,
      trainType: { en: trip.trainTypeEn, ar: trip.trainTypeAr },
      travelClass: {
        id: request.travelClassId,
        name: { en: trip.travelClassNameEn, ar: trip.travelClassNameAr },
      },
      departure: {
        stationId: trip.originStationId,
        name: { en: trip.originNameEn, ar: trip.originNameAr },
        at: civilDateTimeOf(new Date(trip.originDepartureMillis)),
      },
      arrival: {
        stationId: trip.destinationStationId,
        name: { en: trip.destinationNameEn, ar: trip.destinationNameAr },
        at: civilDateTimeOf(new Date(trip.destinationArrivalMillis)),
      },
      durationMinutes: trip.durationMinutes,
      intermediateStops: trip.intermediateStops,
      availableSeats,
      // Returned and marked, never hidden (BR-16).
      soldOut: availableSeats === 0,
      fare: {
        // Non-null by the time a trip reaches here; isSellable dropped the rest.
        amountMinor: trip.farePiastres ?? 0,
        currency: FARE_CURRENCY,
      },
    };
  }

  /**
   * Why the list is empty, in terms of the field to change.
   *
   * Only asked when there is nothing to return, so the common path never pays
   * for it. The values go in `params` and the sentence is assembled at the
   * edge, which is what keeps catalog free of any language.
   */
  private async explainEmpty(
    request: SearchOneWayTripsRequest,
    trainNumber: number | null,
    filterOptions: FilterOptions,
    filtersExcludedAll: boolean,
  ): Promise<SearchOneWayTripsResponse['emptyResult']> {
    const probe = await this.trips.probeRouteServed(
      request.originStationId,
      request.destinationStationId,
      trainNumber,
    );

    return {
      reason: emptyReasonFor({
        routeServed: probe.routeServed,
        trainNumberGiven: trainNumber !== null,
        trainServesRoute: probe.trainServesRoute,
        filtersExcludedAll,
      }),
      params: {
        searchedDate: request.departureDate,
        ...(trainNumber === null ? {} : { trainNumber: String(trainNumber) }),
        // The edge uses these to say "change the filters, not the date": the
        // day's actual range is what the filter has to admit.
        ...(filtersExcludedAll
          ? {
              minFareMinor: String(filterOptions.minFareMinor),
              maxFareMinor: String(filterOptions.maxFareMinor),
            }
          : {}),
      },
    };
  }
}
