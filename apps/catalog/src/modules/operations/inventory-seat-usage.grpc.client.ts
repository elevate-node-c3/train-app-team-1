import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';

import { withTimeout } from '@app/messaging/with-timeout.js';
import {
  INVENTORY_SERVICE_NAME,
  type SeatUsageForTripsRequest,
  type SeatUsageForTripsResponse,
  type TripSeatUsage,
} from '@app/contracts';

import { seatUsageTimeoutMs } from '../../config/operations-settings.js';

/** Bound by the owning module's `ClientsModule.registerAsync` entry. */
export const INVENTORY_GRPC_CLIENT = 'INVENTORY_GRPC_CLIENT';

interface InventoryGrpcService {
  seatUsageForTrips(
    data: SeatUsageForTripsRequest,
    metadata?: Metadata,
    options?: CallOptions,
  ): Observable<SeatUsageForTripsResponse>;
}

/**
 * Silence is never zero: every failure becomes this, so a publish refuses
 * instead of guessing (TA-20).
 */
export class SeatUsageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SeatUsageUnavailableError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refuses a malformed count or stations list; defaulting an absent count to
 * zero is the failure this prevents.
 */
function validatedUsage(usage: TripSeatUsage): TripSeatUsage {
  if (
    typeof usage?.tripId !== 'string' ||
    !Number.isInteger(usage.soldCount) ||
    !Number.isInteger(usage.heldCount) ||
    !Array.isArray(usage.stationIdsInUse)
  ) {
    throw new SeatUsageUnavailableError(
      `Inventory returned a malformed seat usage for trip id '${usage?.tripId}'`,
    );
  }
  return usage;
}

function usagesOf(response: SeatUsageForTripsResponse): TripSeatUsage[] {
  if (!response || !Array.isArray(response.usages)) {
    throw new SeatUsageUnavailableError(
      'Inventory returned a malformed seat-usage response',
    );
  }
  return response.usages.map(validatedUsage);
}

/** Catalog's seam into whether a dated trip can be safely rewritten. */
@Injectable()
export class InventorySeatUsageClient implements OnModuleInit {
  private readonly logger = new Logger(InventorySeatUsageClient.name);
  private service!: InventoryGrpcService;

  constructor(
    @Inject(INVENTORY_GRPC_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<InventoryGrpcService>(
      INVENTORY_SERVICE_NAME,
    );
  }

  /**
   * Keyed by trip id. Never returns zeros it does not have: any failure or a
   * missing trip id becomes `SeatUsageUnavailableError`, with no retry.
   */
  async seatUsageForTrips(
    tripIds: string[],
  ): Promise<Map<string, TripSeatUsage>> {
    const timeoutMs = seatUsageTimeoutMs();
    let usages: TripSeatUsage[];

    try {
      const response = await withTimeout(
        firstValueFrom(
          // Deadline and withTimeout are not redundant: gRPC enforces one, and
          // withTimeout covers a channel that never emits it. Without the
          // deadline a timed-out call keeps running against inventory.
          this.service.seatUsageForTrips({ tripIds }, new Metadata(), {
            deadline: Date.now() + timeoutMs,
          }),
        ),
        timeoutMs,
      );
      usages = usagesOf(response);
    } catch (error) {
      if (error instanceof SeatUsageUnavailableError) throw error;
      this.logger.warn(`Seat usage lookup failed: ${messageOf(error)}`);
      throw new SeatUsageUnavailableError(
        'Could not reach inventory for seat usage',
        { cause: error },
      );
    }

    const byTripId = new Map(usages.map((usage) => [usage.tripId, usage]));

    // A gap means a broken or wrong-version inventory, but a partial answer is
    // not a zero, so it still refuses.
    const missing = tripIds.filter((tripId) => !byTripId.has(tripId));
    if (missing.length > 0) {
      throw new SeatUsageUnavailableError(
        `Inventory did not answer for trip id(s): ${missing.join(', ')}`,
      );
    }

    return byTripId;
  }
}
