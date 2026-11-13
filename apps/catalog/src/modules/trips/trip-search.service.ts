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
 * Use one captured now for validation, dates, and eligibility.
 * Recheck sellability after every cache read; cached data has no live sales state.
 * Keep search queries read-only: no analytics events or outbox writes.
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
   * accountId comes from verified caller metadata. Unidentified callers receive
   * the same results, but their searches are not recorded.
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

    // Recheck sales eligibility on both cache hits and misses.
    const eligible = applyDynamicEligibility(statics, now);

    // Build facets before filtering so the traveller can undo any narrowing.
    const filterOptions = filterOptionsFor(eligible);

    // Batch availability for all segments to avoid per-trip calls.
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
   * Record successful searches, including empty results, but never invalid requests.
   * Do not await recording: it must not delay or fail the search response.
   * Catch rejections here even though RecentSearchesService catches internally;
   * unawaited rejections must not terminate the process.
   */
  private recordSearch(
    request: SearchOneWayTripsRequest,
    now: Date,
    accountId: string | null,
    trainNumber: number | null,
  ): void {
    if (accountId === null) return;

    // A return date marks the outbound call as round-trip for recent-search identity.
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
   * Drop unpriced segments: they cannot be booked. Warn so missing fare coverage
   * is repaired as a data gap, not treated as normal emptiness.
   */
  private warnUnpriced(trip: { tripId: string; originStationId: string; destinationStationId: string }): void {
    this.logger.warn(
      `Trip ${trip.tripId} has no fare for ${trip.originStationId} -> ${trip.destinationStationId}; excluded from search`,
    );
  }

  /**
   * Probe only empty results; skip SQL probes when filters removed known candidates.
   * Return reason codes and params for the edge to render in the chosen language.
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
          // Give the day's fare range so the client can relax filters, not change dates.
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
