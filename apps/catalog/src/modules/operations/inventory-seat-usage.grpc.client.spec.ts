import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SeatUsageForTripsResponse, TripSeatUsage } from '@app/contracts';

import {
  InventorySeatUsageClient,
  SeatUsageUnavailableError,
} from './inventory-seat-usage.grpc.client.js';

const TIMEOUT_ENV_VAR = 'INVENTORY_SEAT_USAGE_TIMEOUT_MS';

function usageFor(tripId: string): TripSeatUsage {
  return { tripId, soldCount: 0, heldCount: 0, stationIdsInUse: [] };
}

/** Builds a client whose `ClientGrpc.getService` resolves to the given stub. */
function clientWith(
  seatUsageForTrips: (
    data: unknown,
  ) => Observable<SeatUsageForTripsResponse>,
): InventorySeatUsageClient {
  const grpc = {
    getService: () => ({ seatUsageForTrips }),
  } as unknown as ClientGrpc;

  const client = new InventorySeatUsageClient(grpc);
  client.onModuleInit();
  return client;
}

describe('InventorySeatUsageClient', () => {
  let originalTimeout: string | undefined;

  beforeEach(() => {
    originalTimeout = process.env[TIMEOUT_ENV_VAR];
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env[TIMEOUT_ENV_VAR];
    else process.env[TIMEOUT_ENV_VAR] = originalTimeout;
  });

  it('returns the usage for each trip, keyed by trip id', async () => {
    const client = clientWith(() =>
      of({ usages: [usageFor('trip-a')] }),
    );

    const usage = await client.seatUsageForTrips(['trip-a']);

    expect(usage.get('trip-a')?.soldCount).toBe(0);
  });

  it('throws SeatUsageUnavailableError when inventory is unreachable', async () => {
    const client = clientWith(() =>
      throwError(() => ({ code: 14 /* UNAVAILABLE */ })),
    );

    await expect(client.seatUsageForTrips(['trip-a'])).rejects.toBeInstanceOf(
      SeatUsageUnavailableError,
    );
  });

  it(
    'throws rather than returning zeros when inventory times out',
    async () => {
      process.env[TIMEOUT_ENV_VAR] = '20';
      // Never emits, never errors -- exactly a stopped inventory holding the
      // connection open.
      const client = clientWith(() => new Observable<never>(() => {}));

      await expect(
        client.seatUsageForTrips(['trip-a']),
      ).rejects.toBeInstanceOf(SeatUsageUnavailableError);
    },
    2000,
  );

  // Review Focus 1. A trip missing from the answer is an unanswered
  // question. Reading it as "no tickets" is the story's worst failure.
  it('throws when inventory answers for fewer trips than were asked about', async () => {
    // stub answers only trip-a
    const client = clientWith(() => of({ usages: [usageFor('trip-a')] }));

    await expect(
      client.seatUsageForTrips(['trip-a', 'trip-b']),
    ).rejects.toBeInstanceOf(SeatUsageUnavailableError);
  });
});
