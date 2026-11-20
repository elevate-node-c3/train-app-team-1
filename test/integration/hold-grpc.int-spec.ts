import { createHash, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Transport } from '@nestjs/microservices';
import { ClsModule } from 'nestjs-cls';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DataSource } from 'typeorm';
import {
  DataSourceInitializer,
  MigrationRunnerService,
  SchemaReadinessGate,
  TypeOrmUnitOfWork,
} from '@app/common';
import { TypeOrmOutboxRepository } from '@app/messaging';
import {
  AllocationOutcome,
  ErrorCode,
  INVENTORY_PACKAGE_NAME,
  INVENTORY_SERVICE_NAME,
  getInventoryProtoPath,
  type CreateHoldRequest,
  type HoldSnapshot,
} from '@app/contracts';
import { HoldCoreRepository } from '../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { HoldCoreService } from '../../apps/inventory/src/modules/seat-hold/hold-core.service.js';
import { SeatHoldGrpcController } from '../../apps/inventory/src/modules/seat-hold/seat-hold.grpc.controller.js';
import {
  HoldCreationGuard,
  HoldServiceGuard,
} from '../../apps/inventory/src/modules/seat-hold/hold-access.guard.js';
import { INVENTORY_GRPC_LOADER_OPTIONS } from '../../apps/booking/src/modules/draft/booking-draft.module.js';
import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import { seedSixStopTrip, SIX_STOP_TRIP } from './support/inventory-fixture.js';
import { isolatedHoldEndpoints } from './support/hold-fixture.js';

type Method = 'createHold' | 'getHold' | 'releaseHold' | 'extendHold';
type NativeClient = grpc.Client &
  Record<
    Method,
    (
      request: unknown,
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
      callback: (
        error: grpc.ServiceError | null,
        response?: HoldSnapshot,
      ) => void,
    ) => grpc.ClientUnaryCall
  >;
const key = 'holds-native-inventory-service-credential-test-only';
const trace = randomUUID();
let source: DataSource;
let app: INestMicroservice;
let client: NativeClient;
let returnTripId: string;

function metadata(): grpc.Metadata {
  const result = new grpc.Metadata();
  result.set('x-booking-inventory-key', key);
  result.set('x-correlation-id', trace);
  return result;
}

function call(
  method: Method,
  input: unknown,
  headers = metadata(),
): Promise<HoldSnapshot> {
  return new Promise((resolve, reject) =>
    client[method](
      input,
      headers,
      { deadline: new Date(Date.now() + 10_000) },
      (error, response) => {
        if (error) reject(error);
        else resolve(response!);
      },
    ),
  );
}

function request(): CreateHoldRequest {
  const passengerRefs = [randomUUID(), randomUUID()];
  const legs = [
    {
      tripId: SIX_STOP_TRIP.tripId,
      travelClassId: SIX_STOP_TRIP.travelClassIds[0],
      originStationId: SIX_STOP_TRIP.stationIds[0],
      destinationStationId: SIX_STOP_TRIP.stationIds[2],
    },
    {
      tripId: returnTripId,
      travelClassId: SIX_STOP_TRIP.travelClassIds[0],
      originStationId: SIX_STOP_TRIP.stationIds[2],
      destinationStationId: SIX_STOP_TRIP.stationIds[0],
    },
  ];
  return {
    ownerId: randomUUID(),
    bookingKey: randomUUID(),
    legs,
    passengers: passengerRefs.map((passengerRef) => ({
      passengerRef,
      identities: legs.map((leg) => ({
        tripId: leg.tripId,
        passengerKeyVersion: 1,
        passengerToken: createHash('sha256')
          .update(`holds-wire:${passengerRef}:${leg.tripId}`)
          .digest('hex'),
      })),
    })),
  };
}

beforeAll(async () => {
  isolatedHoldEndpoints();
  vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', key);
  source = await inventoryDataSource();
  const initializer = new DataSourceInitializer(source);
  const core = new HoldCoreService(
    new HoldCoreRepository(),
    new TypeOrmUnitOfWork(initializer),
    new TypeOrmOutboxRepository(initializer),
  );
  const module = await Test.createTestingModule({
    imports: [ClsModule.forRoot()],
    controllers: [SeatHoldGrpcController],
    providers: [
      { provide: HoldCoreService, useValue: core },
      { provide: DataSourceInitializer, useValue: initializer },
      { provide: SchemaReadinessGate, useValue: new SchemaReadinessGate() },
      { provide: MigrationRunnerService, useValue: { hasCompleted: true } },
      HoldCreationGuard,
      HoldServiceGuard,
    ],
  }).compile();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const url = `127.0.0.1:${port}`;
  app = module.createNestMicroservice({
    transport: Transport.GRPC,
    logger: false,
    options: {
      url,
      package: INVENTORY_PACKAGE_NAME,
      protoPath: getInventoryProtoPath(),
      loader: INVENTORY_GRPC_LOADER_OPTIONS,
    },
  });
  await app.listen();
  let definition = grpc.loadPackageDefinition(
    protoLoader.loadSync(
      getInventoryProtoPath(),
      INVENTORY_GRPC_LOADER_OPTIONS,
    ),
  );
  for (const part of INVENTORY_PACKAGE_NAME.split('.'))
    definition = definition[part] as grpc.GrpcObject;
  const Service = definition[
    INVENTORY_SERVICE_NAME
  ] as grpc.ServiceClientConstructor;
  client = new Service(
    url,
    grpc.credentials.createInsecure(),
  ) as unknown as NativeClient;
});

beforeEach(async () => {
  vi.stubEnv('HOLD_CREATION_ENABLED', 'true');
  await truncateInventory(source);
  await seedSixStopTrip(source);
  await source.query(
    `UPDATE inventory_trip SET service_date = (clock_timestamp() + interval '2 hours')::date WHERE id = $1`,
    [SIX_STOP_TRIP.tripId],
  );
  await source.query(
    `UPDATE trip_stop SET departure_at = clock_timestamp() + interval '2 hours' + position * interval '5 minutes', arrival_at = clock_timestamp() + interval '2 hours' + position * interval '5 minutes' WHERE trip_id = $1`,
    [SIX_STOP_TRIP.tripId],
  );
  returnTripId = randomUUID();
  // Copy the existing fixture geometry, reversing stops for the return leg.
  await source.query(
    `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
    SELECT $2, status, timetable_version, train_id, train_number, service_date FROM inventory_trip WHERE id = $1`,
    [SIX_STOP_TRIP.tripId, returnTripId],
  );
  await source.query(
    `INSERT INTO trip_stop (trip_id, station_id, position, departure_at, arrival_at)
    SELECT $2, station_id, 5 - position, clock_timestamp() + interval '4 hours' + (5 - position) * interval '5 minutes', clock_timestamp() + interval '4 hours' + (5 - position) * interval '5 minutes'
    FROM trip_stop WHERE trip_id = $1`,
    [SIX_STOP_TRIP.tripId, returnTripId],
  );
  await source.query(
    `INSERT INTO trip_coach (id, trip_id, coach_number, position, travel_class_id, travel_class_name_en, travel_class_name_ar)
    SELECT gen_random_uuid(), $2, coach_number, position, travel_class_id, travel_class_name_en, travel_class_name_ar FROM trip_coach WHERE trip_id = $1`,
    [SIX_STOP_TRIP.tripId, returnTripId],
  );
  await source.query(
    `INSERT INTO trip_seat (id, trip_id, trip_coach_id, seat_number, travel_class_id, row_number, side, seat_index_in_side)
    SELECT gen_random_uuid(), $2, replacement.id, s.seat_number, s.travel_class_id, s.row_number, s.side, s.seat_index_in_side
    FROM trip_seat s JOIN trip_coach original ON original.id = s.trip_coach_id
    JOIN trip_coach replacement ON replacement.trip_id = $2 AND replacement.coach_number = original.coach_number
    WHERE s.trip_id = $1`,
    [SIX_STOP_TRIP.tripId, returnTripId],
  );
});

afterAll(async () => {
  client?.close();
  await app?.close();
  await closeInventoryDataSource();
  vi.unstubAllEnvs();
});

describe('TA-70 live private Inventory protobuf transport', () => {
  it('refuses unauthenticated calls without writing a hold', async () => {
    await expect(
      call('createHold', request(), new grpc.Metadata()),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    const [row] = await source.query(
      'SELECT count(*)::integer AS count FROM seat_hold_group',
    );
    expect(row.count).toBe(0);
  });

  it('creates every passenger/leg, replays the receipt, and carries private overlap refusals', async () => {
    const req = request();
    const held = await call('createHold', req);
    expect(held).toMatchObject({
      ownerId: req.ownerId,
      bookingKey: req.bookingKey,
      state: 'HELD',
      version: 1,
      extensionUsed: false,
    });
    expect(held.legs).toHaveLength(2);
    expect(held.assignments).toHaveLength(4);
    expect(Object.values(AllocationOutcome)).toContain(held.allocationOutcome);
    expect(
      new Date(held.expiresAt as string).getTime() -
        new Date(held.serverNow).getTime(),
    ).toBe(15 * 60_000);
    const replay = await call('createHold', req);
    expect(replay.holdId).toBe(held.holdId);
    expect(replay.expiresAt).toBe(held.expiresAt);
    expect(replay.assignments).toEqual(held.assignments);
    const passengerRef = randomUUID();
    const conflicting = {
      ...req,
      ownerId: randomUUID(),
      bookingKey: randomUUID(),
      passengers: [{ ...req.passengers[0], passengerRef }],
    };
    // The refusal names the passenger, as a detail ref the edge resolves into
    // Arabic or English (TA-70, BR-57). Inventory holds no National ID, so the
    // booking reference is what it can name.
    await expect(call('createHold', conflicting)).rejects.toMatchObject({
      code: grpc.status.ABORTED,
      details: JSON.stringify({
        code: ErrorCode.PASSENGER_OVERLAP,
        details: [
          {
            field: 'passengerRefs',
            rejectedValue: { passengerRef },
            issueKey: 'ISSUE_PASSENGER_ALREADY_BOOKED',
            actionKey: 'ACTION_REMOVE_PASSENGER_OR_PICK_ANOTHER_TRAIN',
          },
        ],
      }),
    });
    const [event] = await source.query(
      `SELECT correlation_id FROM outbox_event WHERE event_type = 'inventory.hold.held'`,
    );
    expect(event.correlation_id).toBe(trace);
  });

  it('extends once and keeps get/release available while creation is disabled', async () => {
    const req = request();
    const held = await call('createHold', req);
    const identity = { ownerId: req.ownerId, bookingKey: req.bookingKey };
    const extended = await call('extendHold', identity);
    expect(extended).toMatchObject({
      state: 'HELD',
      version: 2,
      extensionUsed: true,
    });
    expect(
      new Date(extended.expiresAt as string).getTime() -
        new Date(held.expiresAt as string).getTime(),
    ).toBe(5 * 60_000);
    await expect(call('extendHold', identity)).rejects.toMatchObject({
      code: grpc.status.FAILED_PRECONDITION,
    });
    vi.stubEnv('HOLD_CREATION_ENABLED', 'false');
    await expect(call('createHold', request())).rejects.toMatchObject({
      code: grpc.status.UNAVAILABLE,
    });
    expect((await call('getHold', identity)).state).toBe('HELD');
    expect(await call('releaseHold', identity)).toMatchObject({
      state: 'RELEASED',
      version: 3,
    });
    expect(await call('releaseHold', identity)).toMatchObject({
      state: 'RELEASED',
      version: 3,
    });
  });

  it('transports effective expiry and an empty-expiry cancellation fence correctly', async () => {
    const req = request();
    const held = await call('createHold', req);
    await source.transaction(async (manager) => {
      const [row] = await manager.query(
        `SELECT clock_timestamp() - interval '30 seconds' AS deadline`,
      );
      await manager.query(
        'UPDATE seat_hold_group SET expires_at = $2 WHERE id = $1',
        [held.holdId, row.deadline],
      );
      await manager.query(
        'UPDATE seat_occupation SET hold_expires_at = $2 WHERE hold_id = $1',
        [held.holdId, row.deadline],
      );
    });
    const identity = { ownerId: req.ownerId, bookingKey: req.bookingKey };
    expect(await call('getHold', identity)).toMatchObject({
      state: 'EXPIRED',
      version: 2,
    });
    await expect(call('extendHold', identity)).rejects.toMatchObject({
      code: grpc.status.FAILED_PRECONDITION,
    });
    const unknown = { ownerId: randomUUID(), bookingKey: randomUUID() };
    expect(await call('releaseHold', unknown)).toMatchObject({
      state: 'CANCELLED',
      expiresAt: '',
      legs: [],
      assignments: [],
    });
    expect(await call('getHold', unknown)).toMatchObject({
      state: 'CANCELLED',
      version: 1,
    });
  });
});
