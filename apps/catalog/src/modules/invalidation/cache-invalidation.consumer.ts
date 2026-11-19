import { Injectable, Logger, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  EVENT_TYPES,
  type EventEnvelope,
  type FareChangedPayloadV1,
  type HoldLifecyclePayloadV1,
  type SeatAvailabilityChangedPayloadV1,
  type TimetablePublishedPayloadV1,
} from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';

import { RouteVersionService } from '../cache/route-version.service.js';
import { StationsService } from '../stations/services/stations.service.js';
import {
  availabilityVersionCacheKey,
  segmentAvailabilityCacheKey,
} from '../trips/services/seat-availability.service.js';
import { TripStopsService } from '../trips/services/trip-stops.service.js';

/** Invalidate only affected cache entries, leaving unrelated routes untouched. */
@Injectable()
export class CacheInvalidationConsumer implements EventHandlerPort {
  private readonly logger = new Logger(CacheInvalidationConsumer.name);

  constructor(
    private readonly routeVersion: RouteVersionService,
    private readonly stations: StationsService,
    private readonly tripStops: TripStopsService,
    @Optional() private readonly cache?: CacheAsideService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    this.logger.log(
      `Received invalidation event ${envelope.type} (${envelope.id})`,
    );

    switch (envelope.type) {
      case EVENT_TYPES.fareChanged: {
        const payload = envelope.payload as FareChangedPayloadV1;
        await this.routeVersion.incrementRouteVersion(
          payload.originStationId,
          payload.destinationStationId,
        );
        this.logger.log(
          `Incremented route version for fare change: ${payload.originStationId} -> ${payload.destinationStationId}`,
        );
        return { status: 'handled' };
      }

      case EVENT_TYPES.timetablePublished: {
        const payload = envelope.payload as TimetablePublishedPayloadV1;
        await this.routeVersion.incrementRouteVersion(
          payload.originStationId,
          payload.destinationStationId,
        );

        if (payload.intermediateStationIds?.length) {
          for (const inter of payload.intermediateStationIds) {
            await this.routeVersion.incrementRouteVersion(
              payload.originStationId,
              inter,
            );
            await this.routeVersion.incrementRouteVersion(
              inter,
              payload.destinationStationId,
            );
          }
        }

        if (payload.tripId) {
          await this.tripStops.invalidate(
            payload.tripId,
            payload.originStationId,
            payload.destinationStationId,
          );
        }

        this.logger.log(
          `Invalidated route and stops for timetable publish: ${payload.timetableId}`,
        );
        return { status: 'handled' };
      }

      case EVENT_TYPES.stationChanged: {
        await this.stations.invalidate();
        this.logger.log('Invalidated cached stations catalog (CAT-1)');
        return { status: 'handled' };
      }

      case EVENT_TYPES.seatAvailabilityChanged: {
        if (this.cache) {
          const payload = envelope.payload as SeatAvailabilityChangedPayloadV1;
          const rawVersion = await this.cache.get<number>(
            availabilityVersionCacheKey(payload.tripId),
          );
          const version =
            Number.isInteger(rawVersion) && (rawVersion as number) > 0
              ? (rawVersion as number)
              : 1;
          const key = segmentAvailabilityCacheKey(payload, version);
          await this.cache.del(key);
          this.logger.log(`Invalidated seat availability key: ${key}`);
        }
        return { status: 'handled' };
      }

      case EVENT_TYPES.holdHeld:
      case EVENT_TYPES.holdReleased:
      case EVENT_TYPES.holdExpired:
      case EVENT_TYPES.holdExtended: {
        if (!this.cache)
          throw new Error('Seat availability cache is unavailable');
        const payload = envelope.payload as Partial<HoldLifecyclePayloadV1>;
        if (!Array.isArray(payload.legs) || payload.legs.length === 0) {
          throw new Error('Invalid hold lifecycle payload');
        }
        const tripIds = new Set<string>();
        for (const leg of payload.legs) {
          if (
            !leg ||
            typeof leg.tripId !== 'string' ||
            leg.tripId.length === 0
          ) {
            throw new Error('Invalid hold lifecycle payload');
          }
          tripIds.add(leg.tripId);
        }
        for (const tripId of tripIds) {
          const key = availabilityVersionCacheKey(tripId);
          let version = await this.cache.increment(key);
          // Missing counters start at one; first invalidation must move v1 to v2.
          if (version === 1) version = await this.cache.increment(key);
          if (version === null)
            throw new Error('Seat availability invalidation failed');
          this.logger.log(
            `Advanced seat availability generation for trip ${tripId}`,
          );
        }
        return { status: 'handled' };
      }

      default:
        this.logger.warn(`Unrecognized invalidation event: ${envelope.type}`);
        return { status: 'skipped', skipReason: 'unrecognized_event_type' };
    }
  }
}
