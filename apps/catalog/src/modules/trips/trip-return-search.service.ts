import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  cairoLocalTimeOf,
  civilDateTimeOf,
  type SearchReturnTripsRequest,
  type SearchReturnTripsResponse,
  type ValidationErrorDetail,
} from '@app/contracts';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { CatalogSearchError } from './catalog-search-error.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripDayService } from './trip-day.service.js';
import { buildTripList } from './trip-result.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { emptyReasonFor } from './trip-search-empty-reason.js';
import { filterOptionsFor, validateFilters } from './trip-search-filters.js';
import {
  isUuid,
  validateReturnDate,
} from './trip-search-validation.js';
import { applyDynamicEligibility } from './trip-sellability.js';
import type { PassengerSegmentRow } from './trip-search.types.js';

/**
 * The return leg of a round trip.
 *
 * Two things make this a different service rather than a flag on the one-way
 * search. The list is computed *from a trip the traveller chose*, so it has an
 * input the first leg does not have and cannot have; and its lower bound is an
 * instant the server reads for itself.
 *
 * That bound is the whole of BR-20. The request carries no arrival time, and if
 * it did this service would ignore it: a client that could send one could widen
 * the window and be offered a return train it cannot physically catch. Strictly
 * after, with no minimum connection time -- a decision, not an oversight: the
 * platform does not know how long this station takes to cross, and inventing a
 * number would silently hide legal journeys.
 *
 * Everything else is deliberately the outbound leg's machinery. The reverse
 * route on the return date is a plain day query, so it goes through
 * `TripDayService` and lands on the same cache key any other search for that day
 * uses -- a round trip adds no cache key of its own -- and the list is narrowed,
 * ordered and mapped by `buildTripList`, so "filters apply to each list
 * separately" cannot drift into "the two lists filter by different rules".
 *
 * Read-only, like the first leg: no events, no outbox rows, no writes. It also
 * records no recent search -- the outbound call already did, and this is the
 * same search continued.
 */
@Injectable()
export class TripReturnSearchService {
  private readonly logger = new Logger(TripReturnSearchService.name);

  constructor(
    private readonly trips: TripSearchRepository,
    private readonly references: CatalogReferenceRepository,
    private readonly availability: SeatAvailabilityService,
    private readonly day: TripDayService,
  ) {}

  async search(
    request: SearchReturnTripsRequest,
    now: Date,
  ): Promise<SearchReturnTripsResponse> {
    this.refuseMalformed(request);

    // The chosen trip, read before the return date is judged: the date it has
    // to be on or after is the trip's own departure date, which only the
    // server knows.
    const segment = await this.outboundSegment(request);

    const dateDetails = validateReturnDate(
      request.returnDate,
      segment.cairoDepartureDate,
      now,
    );
    if (dateDetails.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, dateDetails);
    }

    await this.refuseUnknownReferences(request, segment);

    // The exact reverse: back to where the traveller started, in the same
    // class. No train number -- that narrowed the outbound leg only, and a
    // return train has its own number.
    const statics = await this.day.staticTripsFor(
      {
        originStationId: segment.destinationStationId,
        destinationStationId: segment.originStationId,
        serviceDate: request.returnDate,
        travelClassId: request.travelClassId,
        trainNumber: null,
      },
      now,
    );

    const eligible = applyDynamicEligibility(statics, now);

    // The arrival bound comes BEFORE the filters, so a list the bound emptied
    // is never blamed on a filter that had nothing to remove.
    const arrivalMillis = segment.destinationArrivalAt.getTime();
    const afterArrival = eligible.filter(
      (trip) => trip.originDepartureMillis > arrivalMillis,
    );

    // Facets describe what the traveller can actually choose from, which on
    // this leg means after the arrival bound and before their own filters.
    const filterOptions = filterOptionsFor(afterArrival);

    const seats = await this.availability.availabilityFor(
      afterArrival.map((trip) => ({
        tripId: trip.tripId,
        originStationId: trip.originStationId,
        destinationStationId: trip.destinationStationId,
        travelClassId: request.travelClassId,
        classCapacity: trip.classCapacity,
      })),
    );

    const { trips, filteredCount } = buildTripList({
      eligible: afterArrival,
      seats,
      travelClassId: request.travelClassId,
      filters: request.filters,
      sort: request.sort,
      onUnpriced: (trip) =>
        this.logger.warn(
          `Trip ${trip.tripId} has no fare for ${trip.originStationId} -> ${trip.destinationStationId}; excluded from the return list`,
        ),
    });

    return {
      trips,
      evaluatedAt: civilDateTimeOf(now),
      filterOptions,
      ...(trips.length === 0
        ? {
            emptyResult: await this.explainEmpty({
              request,
              segment,
              dayHadTrips: eligible.length > 0,
              survivedArrival: afterArrival.length,
              filteredCount,
            }),
          }
        : {}),
    };
  }

  /** Shape first, so an obvious refusal costs no queries. */
  private refuseMalformed(request: SearchReturnTripsRequest): void {
    const details: ValidationErrorDetail[] = [];

    for (const [field, value] of [
      ['outboundTripId', request.outboundTripId],
      ['outboundOriginStationId', request.outboundOriginStationId],
      ['outboundDestinationStationId', request.outboundDestinationStationId],
      ['travelClassId', request.travelClassId],
    ] as const) {
      if (isUuid(value)) continue;

      details.push({
        field,
        rejectedValue: value,
        issue: 'is not a valid identifier',
        action: 'Choose the outbound trip from the search results again',
      });
    }

    details.push(...validateFilters(request.filters));

    if (details.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    }
  }

  /**
   * The chosen outbound trip, or a refusal.
   *
   * `findPassengerSegment` only answers for sellable trips, so a trip
   * withdrawn between the two lists arrives here as nothing -- and that is the
   * honest answer: the journey the traveller picked no longer exists, and
   * computing a return list around it would be inventing a bound. Selling out
   * is NOT this case: BR-16 returns a sold-out trip marked, so it stays a legal
   * outbound choice.
   */
  private async outboundSegment(
    request: SearchReturnTripsRequest,
  ): Promise<PassengerSegmentRow> {
    const segment = await this.trips.findPassengerSegment(
      request.outboundTripId,
      request.outboundOriginStationId,
      request.outboundDestinationStationId,
    );

    if (segment === null) {
      throw new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, [
        {
          field: 'outboundTripId',
          rejectedValue: request.outboundTripId,
          issue: 'is no longer an available trip between those stations',
          action: 'Search again and choose an outbound trip',
        },
      ]);
    }

    return segment;
  }

  /**
   * The class and the two stations, against the catalogue.
   *
   * The stations come from the segment rather than the request: they are the
   * ones the return list will actually be searched between, and a deactivated
   * station is refused rather than answered with an empty list -- "nothing runs
   * that day" would send the traveller to change the date forever.
   */
  private async refuseUnknownReferences(
    request: SearchReturnTripsRequest,
    segment: PassengerSegmentRow,
  ): Promise<void> {
    const facts = await this.references.resolveReferences({
      stationIds: [segment.originStationId, segment.destinationStationId],
      travelClassId: request.travelClassId,
      trainNumber: null,
    });

    const details: ValidationErrorDetail[] = [];

    if (!facts.travelClassExists) {
      details.push({
        field: 'travelClassId',
        rejectedValue: request.travelClassId,
        issue: 'is not an offered seat class',
        action: 'Choose a seat class from the list',
      });
    }

    // Named against the outbound fields, because those are what the traveller
    // would change: the return origin IS the outbound destination.
    for (const [field, stationId] of [
      ['outboundDestinationStationId', segment.destinationStationId],
      ['outboundOriginStationId', segment.originStationId],
    ] as const) {
      if (!facts.activeStationIds.has(stationId)) {
        details.push({
          field,
          rejectedValue: stationId,
          issue: 'is not an active station',
          action: 'Search again with another station',
        });
      }
    }

    if (details.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    }
  }

  /**
   * Why the return list is empty, in terms of what to change.
   *
   * The two cases the story insists stay distinguishable are decided here
   * without a query: if the day had trips and none survived the arrival bound,
   * the route is served by construction, so the probes have nothing to add.
   * Only a day that was empty to begin with pays for them.
   */
  private async explainEmpty(context: {
    request: SearchReturnTripsRequest;
    segment: PassengerSegmentRow;
    dayHadTrips: boolean;
    survivedArrival: number;
    filteredCount: number;
  }): Promise<SearchReturnTripsResponse['emptyResult']> {
    const { request, segment, dayHadTrips, survivedArrival, filteredCount } =
      context;

    const arrival = cairoLocalTimeOf(segment.destinationArrivalAt);
    const arrivalParams = {
      outboundTripId: request.outboundTripId,
      outboundArrivalDate: civilDateTimeOf(segment.destinationArrivalAt)
        .localDate,
      outboundArrivalTime: arrival.localTime,
      searchedDate: request.returnDate,
    };

    if (dayHadTrips) {
      return {
        reason: emptyReasonFor({
          routeServed: true,
          trainNumberGiven: false,
          trainServesRoute: false,
          nothingAfterOutboundArrival: survivedArrival === 0,
          filtersExcludedAll: survivedArrival > 0 && filteredCount === 0,
        }),
        params: arrivalParams,
      };
    }

    const probe = await this.trips.probeRouteServed(
      segment.destinationStationId,
      segment.originStationId,
      null,
    );

    return {
      reason: emptyReasonFor({
        routeServed: probe.routeServed,
        trainNumberGiven: false,
        trainServesRoute: false,
        filtersExcludedAll: false,
      }),
      params: arrivalParams,
    };
  }
}
