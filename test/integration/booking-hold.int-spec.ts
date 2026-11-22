import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DataSource } from 'typeorm';
import type { ClsService } from 'nestjs-cls';
import { status } from '@grpc/grpc-js';
import {
  ErrorCode,
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_EXTENDED_EVENT_TYPE,
  HOLD_RELEASED_EVENT_TYPE,
  type HoldSnapshot,
} from '@app/contracts';
import { migrations } from '../../apps/booking/src/database/migrations/index.js';
import { CreateBookingDraftTables1793500000000 } from '../../apps/booking/src/database/migrations/1793500000000-create-booking-draft-tables.js';
import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { BookingDraftStore } from '../../apps/booking/src/modules/draft/booking-draft.store.js';
import {
  BookingDraftService,
  type BookingIdentityGrpcService,
  type InventoryGrpcService,
} from '../../apps/booking/src/modules/draft/booking-draft.service.js';
import { BookingHoldLifecycleConsumer } from '../../apps/booking/src/modules/draft/hold-lifecycle.consumer.js';
import {
  OTHER_OWNER_ID,
  OWNER_ID,
  SERVER_NOW,
  createRequest,
  draftInput,
  holdEvent,
  inventorySnapshot,
  resolvedPassengers,
} from '../../apps/booking/src/modules/draft/testing/hold-fixtures.js';

function dedicatedBookingUrl(): string {
  const value = process.env.BOOKING_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'Set BOOKING_TEST_DATABASE_URL for the isolated TA-70 Booking database.',
    );
  const url = new URL(value);
  const port = process.env.POSTGRES_HOST_PORT?.trim() || '15432';
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== port ||
    url.pathname !== '/booking' ||
    url.username !== 'booking'
  ) {
    throw new Error(
      `Booking integration tests require booking@127.0.0.1:${port}/booking.`,
    );
  }
  return value;
}

describe('TA-70 Booking durable orchestration (real PostgreSQL)', () => {
  const schema = `holds_booking_${randomUUID().replaceAll('-', '')}`;
  const legacyId = randomUUID();
  const cls = {
    get: () => 'holds-booking-correlation',
  } as unknown as ClsService;
  let setup: DataSource;
  let first: DataSource;
  let second: DataSource;
  let store: BookingDraftStore;
  let otherStore: BookingDraftStore;
  let inventory: InventoryGrpcService;
  let identity: BookingIdentityGrpcService;
  let service: BookingDraftService;
  let otherService: BookingDraftService;
  let schemaCreated = false;

  const connection = (
    url: string,
    selectedMigrations = migrations,
  ): DataSource =>
    new DataSource({
      type: 'postgres',
      url,
      schema,
      synchronize: false,
      logging: false,
      entities: [BookingDraftEntity],
      migrations: selectedMigrations,
      extra: {
        connectionTimeoutMillis: 5000,
        options: `-c search_path=${schema},public -c statement_timeout=10000`,
      },
    });

  beforeAll(async () => {
    const url = dedicatedBookingUrl();
    setup = new DataSource({
      type: 'postgres',
      url,
      extra: { connectionTimeoutMillis: 5000 },
    });
    await setup.initialize();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    first = connection(url, [CreateBookingDraftTables1793500000000]);
    await first.initialize();
    await first.runMigrations();
    await first.query(
      `INSERT INTO booking_draft (id,user_id,status,expires_at,legs,created_at)
      VALUES ($1,'historical-owner','CONFIRMED',$2,$3::jsonb,$2)`,
      [
        legacyId,
        SERVER_NOW,
        JSON.stringify([
          { holdId: 'legacy-receipt', seats: ['Historical seat'] },
        ]),
      ],
    );
    await first.destroy();
    first = connection(url);
    await first.initialize();
    await first.runMigrations();
    second = connection(url);
    await second.initialize();
  });

  afterAll(async () => {
    if (second?.isInitialized) await second.destroy();
    if (first?.isInitialized) await first.destroy();
    if (schemaCreated && setup?.isInitialized)
      await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (setup?.isInitialized) await setup.destroy();
  });

  beforeEach(() => {
    vi.stubEnv(
      'BOOKING_INVENTORY_SERVICE_KEY',
      'inventory-booking-test-key'.padEnd(40, '-'),
    );
    vi.stubEnv(
      'BOOKING_IDENTITY_SERVICE_KEY',
      'identity-booking-test-key'.padEnd(40, '-'),
    );
    vi.stubEnv(
      'GATEWAY_BOOKING_SERVICE_KEY',
      'gateway-booking-test-key'.padEnd(40, '-'),
    );
    store = new BookingDraftStore(first.getRepository(BookingDraftEntity));
    otherStore = new BookingDraftStore(
      second.getRepository(BookingDraftEntity),
    );
    inventory = {
      createHold: vi.fn(async (input) => inventorySnapshot(input)),
      getHold: vi.fn().mockRejectedValue({
        code: status.NOT_FOUND,
        details: JSON.stringify({ code: ErrorCode.HOLD_NOT_FOUND }),
      }),
      releaseHold: vi.fn(),
      extendHold: vi.fn(),
    };
    identity = {
      resolveHoldPassengers: vi.fn(async (input) => resolvedPassengers(input)),
    };
    service = new BookingDraftService(store, inventory, identity, cls);
    otherService = new BookingDraftService(
      otherStore,
      inventory,
      identity,
      cls,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('applies a forward migration without losing executed draft history or legacy receipts', async () => {
    const row = await first
      .getRepository(BookingDraftEntity)
      .findOneByOrFail({ id: legacyId });
    expect(row).toMatchObject({
      userId: 'historical-owner',
      status: 'CONFIRMED',
      expiresAt: new Date(SERVER_NOW),
      createdAt: new Date(SERVER_NOW),
      legs: [{ holdId: 'legacy-receipt', seats: ['Historical seat'] }],
      holdIntent: null,
      passengerSnapshot: null,
      holdVersion: 0,
      paymentClientSecret: null,
      sagaAttempts: 0,
    });
    expect(
      (
        await first.query(`SELECT name FROM "${schema}".migrations ORDER BY id`)
      ).map((entry: { name: string }) => entry.name),
    ).toEqual([
      'CreateBookingDraftTables1793500000000',
      'BookingHoldIntent1794764000000',
      'BookingCheckoutFlow1795000000002',
      'BookingConfirmationSaga1797200000001',
      'PaymentEventIdIsText1797200000002',
      'TicketNumberSequence1797300000001',
      'BookingSagaRecovery1797400000001',
    ]);
    await expect(
      service.createDraft({ ...draftInput(), bookingKey: legacyId }),
    ).rejects.toMatchObject({ code: ErrorCode.BOOKING_KEY_CONFLICT });
    expect(
      (
        await first
          .getRepository(BookingDraftEntity)
          .findOneByOrFail({ id: legacyId })
      ).status,
    ).toBe('CONFIRMED');
  });

  it('commits intent/snapshot before RPC and releases all row locks before remote allocation', async () => {
    const dto = draftInput(2);
    vi.mocked(identity.resolveHoldPassengers).mockImplementation(
      async (input) => {
        expect(
          await otherStore.findOwned(dto.bookingKey, OWNER_ID),
        ).toMatchObject({ passengerSnapshot: null, holdRequested: false });
        await second.query(
          'SELECT id FROM booking_draft WHERE id=$1 FOR UPDATE NOWAIT',
          [dto.bookingKey],
        );
        return resolvedPassengers(input);
      },
    );
    vi.mocked(inventory.createHold).mockImplementation(async (input) => {
      const durable = await otherStore.findOwned(dto.bookingKey, OWNER_ID);
      expect(durable).toMatchObject({ holdRequested: true, expiresAt: null });
      expect(
        durable!.passengerSnapshot!.map(({ passengerRef, identities }) => ({
          passengerRef,
          identities,
        })),
      ).toEqual(input.passengers);
      await second.query(
        'SELECT id FROM booking_draft WHERE id=$1 FOR UPDATE NOWAIT',
        [dto.bookingKey],
      );
      return inventorySnapshot(input);
    });
    const response = await service.createDraft(dto);
    expect(response).toMatchObject({
      holdState: 'HELD',
      holdVersion: 1,
      reconciliationPending: false,
    });
    expect(response.legs).toHaveLength(2);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toMatch(
      /passengerToken|passengerKeyVersion|maskedNationalId|passengerSnapshot/,
    );
  });

  it('independent pools race one key and persist exactly one immutable snapshot', async () => {
    const dto = draftInput(2);
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowIdentity: BookingIdentityGrpcService = {
      resolveHoldPassengers: vi.fn(async (input) => {
        entered();
        await barrier;
        return resolvedPassengers(input, 1);
      }),
    };
    const fastIdentity: BookingIdentityGrpcService = {
      resolveHoldPassengers: vi.fn(async (input) =>
        resolvedPassengers(input, 2),
      ),
    };
    const slow = new BookingDraftService(
      store,
      inventory,
      slowIdentity,
      cls,
    ).createDraft(dto);
    await firstEntered;
    await new BookingDraftService(
      otherStore,
      inventory,
      fastIdentity,
      cls,
    ).createDraft(dto);
    release();
    await slow;
    const saved = await store.findOwned(dto.bookingKey, OWNER_ID);
    expect(saved!.passengerSnapshot![0].identities[0].passengerKeyVersion).toBe(
      2,
    );
    for (const [input] of vi.mocked(inventory.createHold).mock.calls) {
      expect(input.passengers).toEqual(
        saved!.passengerSnapshot!.map(({ passengerRef, identities }) => ({
          passengerRef,
          identities,
        })),
      );
    }
    expect(
      await first
        .getRepository(BookingDraftEntity)
        .countBy({ id: dto.bookingKey }),
    ).toBe(1);
    await expect(
      otherService.createDraft({ ...dto, userId: OTHER_OWNER_ID }),
    ).rejects.toMatchObject({ code: ErrorCode.BOOKING_KEY_CONFLICT });
    await expect(
      otherService.createDraft({ ...dto, passengerIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: ErrorCode.BOOKING_KEY_CONFLICT });
  });

  it('a consumer event before response save prevents persisted and HTTP-visible resurrection', async () => {
    const dto = draftInput();
    const consumer = new BookingHoldLifecycleConsumer(otherStore, otherService);
    vi.mocked(inventory.createHold).mockImplementation(async (input) => {
      const held = inventorySnapshot(input);
      await consumer.handle(
        holdEvent(
          { ...held, state: 'EXPIRED', version: 2 },
          HOLD_EXPIRED_EVENT_TYPE,
          'expired',
        ),
      );
      return held;
    });
    expect(await service.createDraft(dto)).toMatchObject({
      status: 'CANCELLED',
      holdState: 'EXPIRED',
      holdVersion: 2,
    });
    expect(await otherStore.findOwned(dto.bookingKey, OWNER_ID)).toMatchObject({
      status: 'CANCELLED',
      holdVersion: 2,
      holdSnapshot: null,
    });
  });

  it('rechecks the monotonic version after a real row-lock wait', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    const held = inventorySnapshot(createRequest(dto));
    const runner = second.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let pending: Promise<BookingDraftEntity> | undefined;
    try {
      await runner.query(
        'SELECT id FROM booking_draft WHERE id=$1 FOR UPDATE',
        [dto.bookingKey],
      );
      const [{ pid }] = (await runner.query(
        'SELECT pg_backend_pid() AS pid',
      )) as { pid: number }[];
      pending = store.applySnapshot(held);
      await vi.waitFor(
        async () => {
          const [{ count }] = (await setup.query(
            `SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname='booking' AND $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          )) as { count: number }[];
          expect(count).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 10 },
      );
      await runner.query(
        `UPDATE booking_draft SET hold_version=3,hold_state='EXPIRED',status='CANCELLED',reconciliation_pending=true WHERE id=$1`,
        [dto.bookingKey],
      );
      await runner.commitTransaction();
      await pending;
      expect(
        await otherStore.findOwned(dto.bookingKey, OWNER_ID),
      ).toMatchObject({
        status: 'CANCELLED',
        holdState: 'EXPIRED',
        holdVersion: 3,
      });
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await pending?.catch(() => undefined);
    }
  });

  it('duplicate and out-of-order consumers converge atomically without losing the terminal version', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    const held = inventorySnapshot(createRequest(dto));
    const extended = {
      ...held,
      version: 2,
      extensionUsed: true,
      expiresAt: '2026-11-15T17:12:00.000Z',
    };
    const terminal: HoldSnapshot = {
      ...extended,
      state: 'RELEASED',
      version: 3,
    };
    vi.mocked(inventory.getHold).mockResolvedValue(terminal);
    const consumers = [
      new BookingHoldLifecycleConsumer(store, service),
      new BookingHoldLifecycleConsumer(otherStore, otherService),
    ];
    const events = [
      holdEvent(held),
      holdEvent(extended, HOLD_EXTENDED_EVENT_TYPE, 'extended'),
      holdEvent(terminal, HOLD_RELEASED_EVENT_TYPE, 'released'),
    ];
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        consumers[index % 2].handle(events[index % 3]),
      ),
    );
    expect(await store.findOwned(dto.bookingKey, OWNER_ID)).toMatchObject({
      status: 'CANCELLED',
      holdState: 'RELEASED',
      holdVersion: 3,
      extensionUsed: true,
    });
    await store.applySnapshot(held);
    await otherStore.applyEvent(holdEvent({ ...held, version: 4 }).payload);
    expect(
      (await otherStore.findOwned(dto.bookingKey, OWNER_ID))!.holdVersion,
    ).toBe(3);
  });

  it('survives response-save failure across service instances without issuing another create or snapshot', async () => {
    const dto = draftInput();
    vi.spyOn(store, 'applySnapshot').mockRejectedValueOnce(
      new Error('simulated write failure'),
    );
    expect(await service.createDraft(dto)).toMatchObject({
      holdState: 'HELD',
      reconciliationPending: true,
    });
    expect(await otherStore.findOwned(dto.bookingKey, OWNER_ID)).toMatchObject({
      holdRequested: true,
      holdSnapshot: null,
    });
    vi.mocked(inventory.getHold).mockResolvedValue(
      inventorySnapshot(createRequest(dto)),
    );
    expect(await otherService.createDraft(dto)).toMatchObject({
      holdState: 'HELD',
      reconciliationPending: false,
    });
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(identity.resolveHoldPassengers).toHaveBeenCalledTimes(1);
  });

  it('does not ACK reconciliation success when its receipt save still fails', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    const held = inventorySnapshot(createRequest(dto));
    await otherStore.applyEvent(
      holdEvent(
        { ...held, version: 2, extensionUsed: true },
        HOLD_EXTENDED_EVENT_TYPE,
        'extended',
      ).payload,
    );
    vi.mocked(inventory.getHold).mockResolvedValue({
      ...held,
      version: 2,
      extensionUsed: true,
    });
    vi.spyOn(store, 'applySnapshot').mockRejectedValueOnce(
      new Error('save failed'),
    );
    await expect(
      service.reconcileHold(OWNER_ID, dto.bookingKey),
    ).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });
    expect(
      (await otherStore.findOwned(dto.bookingKey, OWNER_ID))!
        .reconciliationPending,
    ).toBe(true);
    await service.reconcileHold(OWNER_ID, dto.bookingKey);
    expect(
      (await otherStore.findOwned(dto.bookingKey, OWNER_ID))!
        .reconciliationPending,
    ).toBe(false);
  });

  it('durably rejects a whole request without releasing an old booking', async () => {
    const original = draftInput();
    await service.createDraft(original);
    const replacement = draftInput(2);
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.ABORTED,
      details: JSON.stringify({ code: ErrorCode.SEAT_TAKEN }),
    });
    await expect(otherService.createDraft(replacement)).rejects.toMatchObject({
      code: ErrorCode.SEAT_TAKEN,
    });
    expect(
      await store.findOwned(replacement.bookingKey, OWNER_ID),
    ).toMatchObject({ status: 'FAILED', holdId: null, legs: [] });
    expect(await store.findOwned(original.bookingKey, OWNER_ID)).toMatchObject({
      status: 'PENDING',
      holdState: 'HELD',
    });
    expect(inventory.releaseHold).not.toHaveBeenCalled();
  });

  it('fences a timed-out create with owner/key release and refuses wrong-owner lifecycle operations', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.DEADLINE_EXCEEDED,
    });
    expect(await service.createDraft(dto)).toMatchObject({
      status: 'PENDING',
      holdState: null,
    });
    expect(
      await otherService.getDraft(dto.bookingKey, OTHER_OWNER_ID),
    ).toBeNull();
    await expect(
      otherService.releaseHold(OTHER_OWNER_ID, dto.bookingKey),
    ).rejects.toMatchObject({ code: ErrorCode.HOLD_NOT_FOUND });
    await expect(
      otherService.extendHold(OTHER_OWNER_ID, dto.bookingKey),
    ).rejects.toMatchObject({ code: ErrorCode.HOLD_NOT_FOUND });
    vi.mocked(inventory.releaseHold).mockResolvedValue({
      ...inventorySnapshot(createRequest(dto)),
      state: 'CANCELLED',
      expiresAt: null,
      allocationOutcome: null,
      legs: [],
      assignments: [],
    });
    expect(
      await otherService.releaseHold(OWNER_ID, dto.bookingKey),
    ).toMatchObject({ status: 'CANCELLED', holdState: 'CANCELLED' });
    await service.createDraft(dto);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(
      (await store.findOwned(dto.bookingKey, OWNER_ID))!.releaseRequested,
    ).toBe(true);
  });
});
