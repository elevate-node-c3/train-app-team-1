import { Injectable, Logger, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  EVENT_TYPES,
  type EventEnvelope,
  type FareChangedPayloadV1,
  type SeatAvailabilityChangedPayloadV1,
  type TimetablePublishedPayloadV1,
} from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';

import { RouteVersionService } from '../cache/route-version.service.js';
import { StationsService } from '../stations/stations.service.js';
import { segmentAvailabilityCacheKey } from '../trips/seat-availability.service.js';
import { TripStopsService } from '../trips/trip-stops.service.js';

/**
 * Event-driven cache invalidation consumer via Catalog's Inbox (§2.3 rule 2 & §6.3).
 *
 * In response to published timetables, fare modifications, or station changes,
 * invalidates or makes unreachable exactly the affected entries without touching
 * unrelated routes.
 */
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
          const key = segmentAvailabilityCacheKey(payload);
          await this.cache.del(key);
          this.logger.log(`Invalidated seat availability key: ${key}`);
        }
        return { status: 'handled' };
      }

      default:
        this.logger.warn(`Unrecognized invalidation event: ${envelope.type}`);
        return { status: 'skipped', skipReason: 'unrecognized_event_type' };
    }
  }
}
