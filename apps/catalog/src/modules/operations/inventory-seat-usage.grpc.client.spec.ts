import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { CallOptions, Metadata } from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getInventoryProtoPath,
  INVENTORY_PACKAGE_NAME,
  type SeatUsageForTripsResponse,
  type TripSeatUsage,
} from '@app/contracts';

import {
  InventorySeatUsageClient,
  SeatUsageUnavailableError,
} from './inventory-seat-usage.grpc.client.js';
import { INVENTORY_GRPC_LOADER_OPTIONS } from './operations.module.js';

const TIMEOUT_ENV_VAR = 'INVENTORY_SEAT_USAGE_TIMEOUT_MS';

function usageFor(tripId: string): TripSeatUsage {
  return { tripId, soldCount: 0, heldCount: 0, stationIdsInUse: [] };
}

function clientWith(
  seatUsageForTrips: (
    data: unknown,
    metadata?: Metadata,
    options?: CallOptions,
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
    const client = clientWith(() => of({ usages: [usageFor('trip-a')] }));

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
      // Never emits or errors: a stopped inventory holding the connection open.
      const client = clientWith(() => new Observable<never>(() => {}));

      await expect(
        client.seatUsageForTrips(['trip-a']),
      ).rejects.toBeInstanceOf(SeatUsageUnavailableError);
    },
    2000,
  );

  // A missing trip is unanswered, not "no tickets".
  it('throws when inventory answers for fewer trips than were asked about', async () => {
    const client = clientWith(() => of({ usages: [usageFor('trip-a')] }));

    await expect(
      client.seatUsageForTrips(['trip-a', 'trip-b']),
    ).rejects.toBeInstanceOf(SeatUsageUnavailableError);
  });

  // Refuse like any unanswerable case; a TypeError would escape the instanceof check.
  it('throws SeatUsageUnavailableError on a malformed response', async () => {
    const client = clientWith(
      () => of({}) as unknown as Observable<SeatUsageForTripsResponse>,
    );

    await expect(client.seatUsageForTrips(['trip-a'])).rejects.toBeInstanceOf(
      SeatUsageUnavailableError,
    );
  });

  it('throws SeatUsageUnavailableError when an entry has a non-integer count', async () => {
    const client = clientWith(() =>
      of({
        usages: [
          {
            tripId: 'trip-a',
            soldCount: Number.NaN,
            heldCount: 0,
            stationIdsInUse: [],
          },
        ],
      }),
    );

    await expect(client.seatUsageForTrips(['trip-a'])).rejects.toBeInstanceOf(
      SeatUsageUnavailableError,
    );
  });

  it('sends a channel deadline so a timed-out call does not keep running', async () => {
    const seen: CallOptions[] = [];
    const before = Date.now();
    const client = clientWith((_data, _metadata, options) => {
      seen.push(options as CallOptions);
      return of({ usages: [usageFor('trip-a')] });
    });

    await client.seatUsageForTrips(['trip-a']);

    expect(seen[0].deadline).toBeGreaterThanOrEqual(before);
  });
});

// Stubs cannot catch this: proto3 omits zero scalars, so decoding zero
// depends on the real loader's `defaults` option.
describe('the real inventory proto loader', () => {
  function tripSeatUsageType(): {
    serialize(message: unknown): Buffer;
    deserialize(buffer: Buffer): Record<string, unknown>;
  } {
    const packageDefinition = protoLoader.loadSync(
      getInventoryProtoPath(),
      INVENTORY_GRPC_LOADER_OPTIONS,
    );
    const loaded = grpc.loadPackageDefinition(packageDefinition);
    const namespace = INVENTORY_PACKAGE_NAME.split('.').reduce<
      Record<string, unknown>
    >(
      (current, part) => current[part] as Record<string, unknown>,
      loaded as unknown as Record<string, unknown>,
    );
    return namespace.TripSeatUsage as ReturnType<typeof tripSeatUsageType>;
  }

  it('decodes an all-zero TripSeatUsage with explicit soldCount and heldCount', () => {
    const TripSeatUsage = tripSeatUsageType();
    const encoded = TripSeatUsage.serialize({
      tripId: 'trip-a',
      soldCount: 0,
      heldCount: 0,
      stationIdsInUse: [],
    });

    const decoded = TripSeatUsage.deserialize(encoded);

    expect(decoded.soldCount).toBe(0);
    expect(decoded.heldCount).toBe(0);
  });
});
