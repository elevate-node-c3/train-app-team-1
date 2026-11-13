import { Injectable } from '@nestjs/common';

import { segmentOf } from './segment.js';
import type { Segment } from './segment.js';
import { AvailabilityRepository } from './availability.repository.js';
import type {
  AvailabilityCount,
  AvailabilityQuery,
  ResolvedAvailabilityQuery,
} from './availability.repository.js';

export class SeatUnknownStationError extends Error {
  constructor(tripId: string, stationId: string) {
    super(`Trip ${tripId} does not stop at station ${stationId}`);
    this.name = 'SeatUnknownStationError';
  }
}

export class SeatSegmentOrderError extends Error {
  constructor(tripId: string, originStationId: string, destinationStationId: string) {
    super(
      `Trip ${tripId}: destination ${destinationStationId} is not after origin ${originStationId}`,
    );
    this.name = 'SeatSegmentOrderError';
  }
}

function resolvedKey(query: {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
}): string {
  return `${query.tripId}:${query.travelClassId}:${query.originStationId}:${query.destinationStationId}`;
}

/**
 * The seam above AvailabilityRepository: resolves stations to positions,
 * raises the two station errors in TypeScript (never in SQL), and turns a
 * missing count row into 0 for a class with no coaches on the train.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly repository: AvailabilityRepository) {}

  async availabilityFor(queries: AvailabilityQuery[]): Promise<AvailabilityCount[]> {
    if (queries.length === 0) return [];

    const positions = await this.repository.positionsFor(queries);
    const resolved: ResolvedAvailabilityQuery[] = queries.map((query) =>
      this.resolve(query, positions),
    );

    const counted = await this.repository.countFor(resolved);
    const countedByKey = new Map(counted.map((count) => [resolvedKey(count), count]));

    return resolved.map(
      (query) =>
        countedByKey.get(resolvedKey(query)) ?? {
          tripId: query.tripId,
          travelClassId: query.travelClassId,
          originStationId: query.originStationId,
          destinationStationId: query.destinationStationId,
          availableSeats: 0,
        },
    );
  }

  private resolve(
    query: AvailabilityQuery,
    positions: Map<string, Map<string, number>>,
  ): ResolvedAvailabilityQuery {
    const byStation = positions.get(query.tripId);
    const originPosition = byStation?.get(query.originStationId);
    if (originPosition === undefined) {
      throw new SeatUnknownStationError(query.tripId, query.originStationId);
    }

    const destinationPosition = byStation?.get(query.destinationStationId);
    if (destinationPosition === undefined) {
      throw new SeatUnknownStationError(query.tripId, query.destinationStationId);
    }

    if (destinationPosition <= originPosition) {
      throw new SeatSegmentOrderError(
        query.tripId,
        query.originStationId,
        query.destinationStationId,
      );
    }

    const segment: Segment = segmentOf(originPosition, destinationPosition);

    return {
      tripId: query.tripId,
      travelClassId: query.travelClassId,
      originStationId: query.originStationId,
      destinationStationId: query.destinationStationId,
      segment,
    };
  }
}
