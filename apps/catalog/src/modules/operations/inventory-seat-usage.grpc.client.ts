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

/** Token the owning module binds to its `ClientsModule.registerAsync` entry. */
export const INVENTORY_GRPC_CLIENT = 'INVENTORY_GRPC_CLIENT';

interface InventoryGrpcService {
  seatUsageForTrips(
    data: SeatUsageForTripsRequest,
    metadata?: Metadata,
    options?: CallOptions,
  ): Observable<SeatUsageForTripsResponse>;
}

/**
 * Silence is never zero. Every failure a publish could mistake for "no
 * tickets" -- a stopped channel, a timeout, a malformed answer, a response
 * missing a trip id -- becomes this instead, so a publish refuses rather
 * than guesses (TA-20).
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
 * Validates one decoded entry rather than trusting the wire. A count that is
 * not a finite integer, or a stations list that is not an array, must refuse
 * -- defaulting an absent count to zero would be the exact "silence is zero"
 * failure this task exists to prevent.
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

/** Guards the response shape itself before trusting `usages` is an array to map over. */
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
   * Keyed by trip id so a caller can ask "did this one sell" per trip. Never
   * returns zeros it does not have: a transport error, a timeout, a
   * malformed answer, or a response missing any requested trip id all
   * become `SeatUsageUnavailableError` -- no retry, because a publish is an
   * interactive action and a stalled retry loop is worse than a prompt
   * refusal.
   */
  async seatUsageForTrips(
    tripIds: string[],
  ): Promise<Map<string, TripSeatUsage>> {
    const timeoutMs = seatUsageTimeoutMs();
    let usages: TripSeatUsage[];

    try {
      const response = await withTimeout(
        firstValueFrom(
          // The channel deadline and withTimeout are not redundant: the
          // deadline is enforced by gRPC itself and covers a server that is
          // slow to answer; withTimeout covers a channel that never
          // produces a deadline event at all. Without the deadline here,
          // a timed-out call keeps running against inventory with nothing
          // telling it to stop.
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

    // Inventory maps every requested id 1:1, so a gap here means a broken or
    // wrong-version inventory, not an expected path -- but a partial answer
    // is an unanswered question, not a zero, so it still refuses.
    const missing = tripIds.filter((tripId) => !byTripId.has(tripId));
    if (missing.length > 0) {
      throw new SeatUsageUnavailableError(
        `Inventory did not answer for trip id(s): ${missing.join(', ')}`,
      );
    }

    return byTripId;
  }
}
