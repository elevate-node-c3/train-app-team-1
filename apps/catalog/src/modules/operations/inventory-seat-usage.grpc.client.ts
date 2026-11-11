import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
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
  ): Observable<SeatUsageForTripsResponse>;
}

/**
 * Silence is never zero. Every failure a publish could mistake for "no
 * tickets" -- a stopped channel, a timeout, a response missing a trip id --
 * becomes this instead, so a publish refuses rather than guesses (TA-20).
 */
export class SeatUsageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SeatUsageUnavailableError';
  }
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
   * returns zeros it does not have: a transport error, a timeout, or a
   * response missing any requested trip id all become
   * `SeatUsageUnavailableError` -- no retry, because a publish is an
   * interactive action and a stalled retry loop is worse than a prompt
   * refusal.
   */
  async seatUsageForTrips(
    tripIds: string[],
  ): Promise<Map<string, TripSeatUsage>> {
    let response: SeatUsageForTripsResponse;
    try {
      response = await withTimeout(
        firstValueFrom(this.service.seatUsageForTrips({ tripIds })),
        seatUsageTimeoutMs(),
      );
    } catch (error) {
      this.logger.warn(
        `Seat usage lookup failed: ${(error as Error).message}`,
      );
      throw new SeatUsageUnavailableError(
        'Could not reach inventory for seat usage',
        { cause: error },
      );
    }

    const byTripId = new Map(
      response.usages.map((usage) => [usage.tripId, usage]),
    );

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
