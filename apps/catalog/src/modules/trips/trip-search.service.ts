import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  bookingWindowFor,
  civilDateTimeOf,
  type FilterOptions,
  type SearchOneWayTripsRequest,
  type SearchOneWayTripsResponse,
} from '@app/contracts';

import { RecentSearchesService } from '../recent-searches/recent-searches.service.js';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { CatalogSearchError } from './catalog-search-error.js';
import { buildDateStrip } from './date-strip.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripDayService } from './trip-day.service.js';
import { buildTripList } from './trip-result.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { emptyReasonFor } from './trip-search-empty-reason.js';
import { filterOptionsFor, validateFilters } from './trip-search-filters.js';
import {
  validateSearchReferences,
  validateSearchShape,
} from './trip-search-validation.js';
import { applyDynamicEligibility } from './trip-sellability.js';

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
    private readonly day: TripDayService,
    private readonly recentSearches: RecentSearchesService,
  ) {}

  /**
   * `accountId` is the signed-in traveller, read from caller metadata by the
   * transport. Absent means an unidentified caller, which search still answers
   * -- the results are identical for everyone -- but records nothing for.
   */
  async search(
    request: SearchOneWayTripsRequest,
    now: Date,
    accountId: string | null = null,
  ): Promise<SearchOneWayTripsResponse> {
    const bookingWindow = bookingWindowFor(now);
    const dateStrip = buildDateStrip(request.departureDate, now);

    await this.refuseInvalid(request, now);

    const trainNumber = request.trainNumber ?? null;
    const statics = await this.day.staticTripsFor(
      {
        originStationId: request.originStationId,
        destinationStationId: request.destinationStationId,
        serviceDate: request.departureDate,
        travelClassId: request.travelClassId,
        trainNumber,
      },
      now,
    );

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

    const { trips, filteredCount } = buildTripList({
      eligible,
      seats,
      travelClassId: request.travelClassId,
      filters: request.filters,
      sort: request.sort,
      onUnpriced: (trip) => this.warnUnpriced(trip),
    });

    const response: SearchOneWayTripsResponse = {
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
              eligible.length > 0 && filteredCount === 0,
            ),
          }
        : {}),
    };

    this.recordSearch(request, now, accountId, trainNumber);

    return response;
  }

  /**
   * Remembers the search, without the traveller waiting for it (BR-21).
   *
   * Not awaited, on purpose. Recording must never slow a search down and never
   * make one fail, and this is the only shape that keeps both promises: the
   * response is already built, and the write happens on its own.
   *
   * The `catch` is belt and braces. `RecentSearchesService.record` already
   * swallows and logs its own failures, but an unawaited promise that rejects
   * takes the process down on an unhandled rejection -- and this service should
   * not stake its own crash-safety on another class's internal discipline.
   *
   * Reached only after a successful answer, which is what makes "a valid
   * search is recorded whether or not it found trains; an invalid request is
   * not" true by construction -- a refusal threw several steps ago.
   */
  private recordSearch(
    request: SearchOneWayTripsRequest,
    now: Date,
    accountId: string | null,
    trainNumber: number | null,
  ): void {
    if (accountId === null) return;

    // The return date is what tells a one-way search from a round trip, and it
    // is the reason the outbound call carries one at all.
    const returnDate =
      request.returnDate === undefined || request.returnDate === ''
        ? null
        : request.returnDate;

    void this.recentSearches
      .record(
        {
          accountId,
          originStationId: request.originStationId,
          destinationStationId: request.destinationStationId,
          travelClassId: request.travelClassId,
          kind: returnDate === null ? 'one_way' : 'round_trip',
          trainNumber,
          departureDate: request.departureDate,
          returnDate,
        },
        now,
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `Recording a recent search rejected unexpectedly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
   * A trip with no fare for the segment cannot be booked, so offering it would
   * strand the traveller one screen later. Logged, because a sellable trip
   * without a price is a data gap someone should fix rather than a normal
   * state.
   */
  private warnUnpriced(trip: { tripId: string; originStationId: string; destinationStationId: string }): void {
    this.logger.warn(
      `Trip ${trip.tripId} has no fare for ${trip.originStationId} -> ${trip.destinationStationId}; excluded from search`,
    );
  }

  /**
   * Why the list is empty, in terms of the field to change.
   *
   * Only asked when there is nothing to return, so the common path never pays
   * for it. The values go in `params` and the sentence is assembled at the
   * edge, which is what keeps catalog free of any language.
   *
   * Filters short-circuit the probes. A day whose trips the filters removed has
   * already proved the route is served and the named train runs it, so asking
   * Postgres again would spend a statement to learn what the result set just
   * demonstrated.
   */
  private async explainEmpty(
    request: SearchOneWayTripsRequest,
    trainNumber: number | null,
    filterOptions: FilterOptions,
    filtersExcludedAll: boolean,
  ): Promise<SearchOneWayTripsResponse['emptyResult']> {
    if (filtersExcludedAll) {
      return {
        reason: emptyReasonFor({
          routeServed: true,
          trainNumberGiven: trainNumber !== null,
          trainServesRoute: trainNumber !== null,
          filtersExcludedAll: true,
        }),
        params: {
          searchedDate: request.departureDate,
          ...(trainNumber === null ? {} : { trainNumber: String(trainNumber) }),
          // The edge uses these to say "change the filters, not the date": the
          // day's actual range is what the filter has to admit.
          minFareMinor: String(filterOptions.minFareMinor),
          maxFareMinor: String(filterOptions.maxFareMinor),
        },
      };
    }

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
      },
    };
  }
}
