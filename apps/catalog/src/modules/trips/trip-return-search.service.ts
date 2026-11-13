import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  cairoLocalTimeOf,
  civilDateTimeOf,
  type SearchReturnTripsRequest,
  type SearchReturnTripsResponse,
  type ValidationIssueRef,
} from '@app/contracts';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { CatalogSearchError } from './catalog-search-error.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripDayService } from './trip-day.service.js';
import { buildTripList } from './trip-result.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { emptyReasonFor } from './trip-search-empty-reason.js';
import { filterOptionsFor, validateFilters } from './trip-search-filters.js';
import { isUuid, validateReturnDate } from './trip-search-validation.js';
import { applyDynamicEligibility } from './trip-sellability.js';
import type { PassengerSegmentRow } from './trip-search.types.js';

/**
 * Bound returns strictly after server-read outbound arrival; never trust client times.
 * Do not invent a minimum connection time; the platform cannot measure it.
 * Reuse the same day cache and list rules; apply filters separately per leg.
 * Return search is read-only: no events, outbox rows, or other writes.
 * Do not record another recent search; the outbound call already did.
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

    // Validate against the server-read outbound departure's Cairo date, not client dates.
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

    // Reverse the pair in the same class; outbound train-number filters do not carry over.
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

    // Apply arrival bounds before filters so impossible connections are not blamed on filters.
    const arrivalMillis = segment.destinationArrivalAt.getTime();
    const afterArrival = eligible.filter(
      (trip) => trip.originDepartureMillis > arrivalMillis,
    );

    // Build return facets after the arrival bound and before request filters.
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
    const details: ValidationIssueRef[] = [];

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
        issueKey:
          field === 'outboundTripId'
            ? 'ISSUE_OUTBOUND_TRIP_ID_MALFORMED'
            : 'ISSUE_MUST_BE_UUID',
        actionKey: 'ACTION_SEARCH_AGAIN_FOR_OUTBOUND',
      });
    }

    details.push(...validateFilters(request.filters));

    if (details.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    }
  }

  /**
   * Refuse an outbound trip withdrawn since search rather than inventing return bounds.
   * Sold-out trips remain valid outbound choices; they are returned and marked.
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
          issueKey: 'ISSUE_OUTBOUND_TRIP_GONE',
          actionKey: 'ACTION_SEARCH_AGAIN_FOR_OUTBOUND',
        },
      ]);
    }

    return segment;
  }

  /**
   * Use the server-read segment's stations; refuse inactive stations rather than
   * returning an empty list that would wrongly blame the return date.
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

    const details: ValidationIssueRef[] = [];

    if (!facts.travelClassExists) {
      details.push({
        field: 'travelClassId',
        rejectedValue: request.travelClassId,
        issueKey: 'ISSUE_SEAT_CLASS_NOT_OFFERED',
        actionKey: 'ACTION_PICK_SEAT_CLASS_FROM_LIST',
      });
    }

    // Name outbound fields: the return origin is the outbound destination.
    for (const [field, stationId] of [
      ['outboundDestinationStationId', segment.destinationStationId],
      ['outboundOriginStationId', segment.originStationId],
    ] as const) {
      if (!facts.activeStationIds.has(stationId)) {
        details.push({
          field,
          rejectedValue: stationId,
          issueKey: 'ISSUE_STATION_NOT_ACTIVE',
          actionKey: 'ACTION_SEARCH_AGAIN_WITH_ANOTHER_STATION',
        });
      }
    }

    if (details.length > 0) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, details);
    }
  }

  /**
   * Distinguish no trips from departures before arrival without probes when the
   * day had trips. Probe route existence only when the original day was empty.
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
