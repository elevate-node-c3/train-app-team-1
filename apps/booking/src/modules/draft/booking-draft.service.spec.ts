import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEVER } from 'rxjs';
import { status } from '@grpc/grpc-js';
import type { ClsService } from 'nestjs-cls';
import {
  AllocationOutcome,
  ErrorCode,
  HOLD_EXPIRED_EVENT_TYPE,
  SEATS_SPLIT_NOTICE,
  type CreateHoldRequest,
} from '@app/contracts';
import {
  BOOKING_GRPC_TIMEOUT_MS,
  BookingDraftService,
  type BookingIdentityGrpcService,
  type InventoryGrpcService,
} from './booking-draft.service.js';
import type { CreateBookingDraftDto } from './dto/create-booking-draft.dto.js';
import {
  EXPIRES_AT,
  HOLD_ID,
  OTHER_OWNER_ID,
  OWNER_ID,
  PASSENGER_IDS,
  SERVER_NOW,
  createRequest,
  draftInput,
  holdEvent,
  inventorySnapshot,
  memoryDraftStore,
  resolvedPassengers,
} from './testing/hold-fixtures.js';

const missing = () => ({
  code: status.NOT_FOUND,
  details: JSON.stringify({ code: ErrorCode.HOLD_NOT_FOUND }),
});

describe('BookingDraftService atomic holds', () => {
  let memory: ReturnType<typeof memoryDraftStore>;
  let service: BookingDraftService;
  let inventory: InventoryGrpcService;
  let identity: BookingIdentityGrpcService;
  const cls = { get: () => 'booking-correlation' } as unknown as ClsService;

  beforeEach(() => {
    vi.stubEnv(
      'BOOKING_INVENTORY_SERVICE_KEY',
      'inventory-booking-test-key'.padEnd(40, '-'),
    );
    vi.stubEnv(
      'BOOKING_IDENTITY_SERVICE_KEY',
      'identity-booking-test-key'.padEnd(40, '-'),
    );
    memory = memoryDraftStore();
    inventory = {
      createHold: vi.fn(async (request) => inventorySnapshot(request)),
      getHold: vi.fn().mockRejectedValue(missing()),
      releaseHold: vi.fn(),
      extendHold: vi.fn(),
    };
    identity = {
      resolveHoldPassengers: vi.fn(async (request) =>
        resolvedPassengers(request),
      ),
    };
    service = new BookingDraftService(memory.store, inventory, identity, cls);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists intent and identity before one single-leg call, uses DB expiry and preserves SIDE_BY_SIDE seats', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockImplementation(
      async (request, metadata, options) => {
        const row = memory.rows.get(dto.bookingKey)!;
        expect(memory.isLocked()).toBe(false);
        expect(row).toMatchObject({
          id: dto.bookingKey,
          userId: OWNER_ID,
          holdRequested: true,
          expiresAt: null,
        });
        expect(row.passengerSnapshot).toHaveLength(2);
        expect(request).toEqual(createRequest(dto));
        expect(request).not.toHaveProperty('ttlSeconds');
        expect(metadata.get('x-booking-inventory-key')).toEqual([
          process.env.BOOKING_INVENTORY_SERVICE_KEY,
        ]);
        expect(metadata.get('x-correlation-id')).toEqual([
          'booking-correlation',
        ]);
        expect(metadata.get('x-caller-account-id')).toEqual([OWNER_ID]);
        expect(metadata.get('accept-language')).toEqual(['en']);
        expect(Number(options.deadline)).toBeGreaterThan(Date.now());
        expect(Number(options.deadline)).toBeLessThanOrEqual(
          Date.now() + BOOKING_GRPC_TIMEOUT_MS,
        );
        return inventorySnapshot(request);
      },
    );
    const result = await service.createDraft(dto, 'en');
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(identity.resolveHoldPassengers).toHaveBeenCalledWith(
      {
        ownerId: OWNER_ID,
        passengerRefs: dto.passengerIds,
        tripIds: dto.legs!.map((leg) => leg.tripId),
      },
      expect.anything(),
      expect.anything(),
    );
    expect(
      vi
        .mocked(identity.resolveHoldPassengers)
        .mock.calls[0][1].get('x-booking-identity-key'),
    ).toEqual([process.env.BOOKING_IDENTITY_SERVICE_KEY]);
    expect(result).toMatchObject({
      id: dto.bookingKey,
      status: 'PENDING',
      holdState: 'HELD',
      holdVersion: 1,
      reconciliationPending: false,
    });
    expect(result.expiresAt).toEqual(new Date(EXPIRES_AT));
    expect(result.serverNow).toEqual(new Date(SERVER_NOW));
    expect(result.legs[0].seats).toEqual([
      'Ahmed Hassan \u00b7 Coach 5 \u00b7 Seat 44',
      'Mona Mahmoud \u00b7 Coach 5 \u00b7 Seat 45',
    ]);
    expect(result.legs[0].assignedSeats?.[0]).toMatchObject({
      seatId: expect.any(String),
      coachNumber: 5,
      rowNumber: 10,
    });
    expect(result.legs[0].splitNotice).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /passengerToken|passengerKeyVersion|maskedNationalId|nationalId|passengerSnapshot/,
    );
  });

  it('retains bilingual SPLIT notice and uses Identity display names, not caller names', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockImplementation(async (request) =>
      inventorySnapshot(request, [AllocationOutcome.SPLIT]),
    );
    const result = await service.createDraft(dto);
    expect(result.legs[0]).toMatchObject({
      allocationOutcome: AllocationOutcome.SPLIT,
      splitNotice: SEATS_SPLIT_NOTICE,
    });
    expect(result.legs[0].splitNotice?.message).toBe(
      SEATS_SPLIT_NOTICE.message,
    );
    expect(result.legs[0].splitNotice?.messageEn).toBe(
      'Seats have been split across coaches because consecutive seats were unavailable',
    );
    expect(result.legs[0].seats).toEqual([
      'Ahmed Hassan \u00b7 Coach 1 \u00b7 Seat 44',
      'Mona Mahmoud \u00b7 Coach 2 \u00b7 Seat 45',
    ]);
    await expect(
      service.createDraft({
        ...dto,
        fullName: 'Caller Forgery',
      } as CreateBookingDraftDto),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('preserves independent per-leg outcomes using ONE atomic request and ONE hold id', async () => {
    const dto = draftInput(2);
    vi.mocked(inventory.createHold).mockImplementation(async (request) =>
      inventorySnapshot(request, [
        AllocationOutcome.SIDE_BY_SIDE,
        AllocationOutcome.SPLIT,
      ]),
    );
    const result = await service.createDraft(dto);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(inventory.createHold).mock.calls[0][0].legs).toHaveLength(
      2,
    );
    expect(
      vi.mocked(inventory.createHold).mock.calls[0][0].passengers[0].identities,
    ).toHaveLength(2);
    expect(result.legs.map((leg) => leg.holdId)).toEqual([HOLD_ID, HOLD_ID]);
    expect(result.legs[0]).toMatchObject({
      allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
    });
    expect(result.legs[0].splitNotice).toBeUndefined();
    expect(result.legs[1]).toMatchObject({
      allocationOutcome: AllocationOutcome.SPLIT,
      splitNotice: SEATS_SPLIT_NOTICE,
    });
    expect(inventory.releaseHold).not.toHaveBeenCalled();
  });

  it('fails the entire round trip on return-leg rejection without saga compensation or partial ownership', async () => {
    const dto = draftInput(2);
    const old = await service.createDraft(draftInput());
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.FAILED_PRECONDITION,
      details: JSON.stringify({
        code: ErrorCode.INSUFFICIENT_SEATS,
        details: [
          {
            field: 'legs',
            rejectedValue: { availableCount: 0 },
            issueKey: 'ISSUE_NOT_ENOUGH_SEATS_ON_TRAIN',
            actionKey: 'ACTION_FEWER_PASSENGERS_OR_ANOTHER_CLASS',
          },
        ],
      }),
    });
    await expect(service.createDraft(dto)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_SEATS,
      availableCount: 0,
    });
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      status: 'FAILED',
      holdId: null,
      legs: [],
    });
    expect(memory.rows.get(old.id)).toMatchObject({
      status: 'PENDING',
      holdState: 'HELD',
    });
    expect(inventory.releaseHold).not.toHaveBeenCalled();
    await expect(service.createDraft(dto)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_SEATS,
    });
    expect(inventory.createHold).toHaveBeenCalledTimes(2);
  });

  it.each([0, 5])(
    'rejects %i passengers before intent or RPC',
    async (count) => {
      const dto = {
        ...draftInput(),
        passengerIds: Array.from({ length: count }, () => randomUUID()),
      };
      await expect(service.createDraft(dto)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(memory.rows.size).toBe(0);
      expect(identity.resolveHoldPassengers).not.toHaveBeenCalled();
      expect(inventory.createHold).not.toHaveBeenCalled();
    },
  );

  it.each([
    { passengerIds: undefined, passengerCount: 2 },
    { passengerIds: undefined, groupSize: 2 },
    { passengerIds: undefined, passengers: [{ nationalId: '29001010112345' }] },
    { passengerIds: [PASSENGER_IDS[0], PASSENGER_IDS[0]] },
    { passengerToken: 'forged-token' },
  ])(
    'rejects legacy count/raw identity or duplicate/token bypass: %j',
    async (extra) => {
      await expect(
        service.createDraft({
          ...draftInput(),
          ...extra,
        } as CreateBookingDraftDto),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(inventory.createHold).not.toHaveBeenCalled();
    },
  );

  it('rejects a third leg before making any partial reservation', async () => {
    const dto = draftInput(2);
    dto.legs!.push({ ...dto.legs![0], tripId: randomUUID() });
    await expect(service.createDraft(dto)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(identity.resolveHoldPassengers).not.toHaveBeenCalled();
    expect(inventory.releaseHold).not.toHaveBeenCalled();
  });

  it('supports existing direct single-leg fields without count-only fallback', async () => {
    const { legs, ...dto } = draftInput();
    const result = await service.createDraft({ ...dto, ...legs![0] });
    expect(result.legs).toHaveLength(1);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
  });

  it('replays immutable IDs, tokens and expiry without resolving Identity again', async () => {
    const dto = draftInput(2);
    const first = await service.createDraft(dto);
    const receipt = memory.rows.get(dto.bookingKey)!.holdSnapshot!;
    vi.mocked(inventory.getHold).mockResolvedValue(receipt);
    vi.mocked(identity.resolveHoldPassengers).mockImplementation(
      async (request) => resolvedPassengers(request, 2),
    );
    const result = await service.createDraft(dto);
    expect(result).toEqual(first);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(identity.resolveHoldPassengers).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'passengers', 'leg', 'order'])(
    'refuses changed %s for an existing immutable key',
    async (change) => {
      const dto = draftInput(2);
      await service.createDraft(dto);
      const modified = structuredClone(dto);
      if (change === 'owner') modified.userId = OTHER_OWNER_ID;
      if (change === 'passengers') modified.passengerIds = [PASSENGER_IDS[2]];
      if (change === 'leg') modified.legs![0].travelClassId = randomUUID();
      if (change === 'order') modified.legs!.reverse();
      await expect(service.createDraft(modified)).rejects.toMatchObject({
        code: ErrorCode.BOOKING_KEY_CONFLICT,
      });
      expect(inventory.createHold).toHaveBeenCalledTimes(1);
      expect(inventory.getHold).not.toHaveBeenCalled();
      expect(identity.resolveHoldPassengers).toHaveBeenCalledTimes(1);
    },
  );

  it('concurrent instances choose one saved identity snapshot before any allocation', async () => {
    const dto = draftInput(2);
    let release!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(identity.resolveHoldPassengers).mockImplementationOnce(
      async (request) => {
        entered();
        await barrier;
        return resolvedPassengers(request, 1);
      },
    );
    const first = service.createDraft(dto);
    await firstEntered;
    const secondIdentity = {
      resolveHoldPassengers: vi.fn(async (request) =>
        resolvedPassengers(request, 2),
      ),
    } as BookingIdentityGrpcService;
    const second = new BookingDraftService(
      memory.store,
      inventory,
      secondIdentity,
      cls,
    );
    await second.createDraft(dto);
    release();
    await first;
    const saved = memory.rows.get(dto.bookingKey)!.passengerSnapshot!;
    expect(saved[0].identities[0].passengerKeyVersion).toBe(2);
    for (const [request] of vi.mocked(inventory.createHold).mock.calls) {
      expect(request.passengers).toEqual(
        saved.map(({ passengerRef, identities }) => ({
          passengerRef,
          identities,
        })),
      );
    }
    expect(memory.rows.size).toBe(1);
  });

  it('keeps PENDING intent on a create timeout and recovers by key without reallocating', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.DEADLINE_EXCEEDED,
      message: 'unsafe secret sql',
    });
    const pending = await service.createDraft(dto);
    expect(pending).toMatchObject({
      status: 'PENDING',
      holdState: null,
      reconciliationPending: true,
    });
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdRequested: true,
      holdFailure: null,
    });
    expect(inventory.releaseHold).not.toHaveBeenCalled();
    vi.mocked(inventory.getHold).mockResolvedValue(
      inventorySnapshot(createRequest(dto)),
    );
    const recovered = await service.createDraft(dto);
    expect(recovered.holdState).toBe('HELD');
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(identity.resolveHoldPassengers).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled Observable and preserves its unknown outcome', async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const invoked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(inventory.createHold).mockImplementation(() => {
      entered();
      return NEVER;
    });
    const pending = service.createDraft(draftInput());
    await invoked;
    await vi.advanceTimersByTimeAsync(BOOKING_GRPC_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({
      status: 'PENDING',
      reconciliationPending: true,
    });
    expect(inventory.releaseHold).not.toHaveBeenCalled();
  });

  it('returns a known committed receipt after save failure; retry reuses durable intent', async () => {
    const dto = draftInput();
    vi.spyOn(memory.store, 'applySnapshot').mockRejectedValueOnce(
      new Error('unsafe database detail'),
    );
    const result = await service.createDraft(dto);
    expect(result).toMatchObject({
      holdState: 'HELD',
      reconciliationPending: true,
    });
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdRequested: true,
      holdSnapshot: null,
    });
    vi.mocked(inventory.getHold).mockResolvedValue(
      inventorySnapshot(createRequest(dto)),
    );
    expect(await service.createDraft(dto)).toMatchObject({
      holdState: 'HELD',
      reconciliationPending: false,
    });
    expect(identity.resolveHoldPassengers).toHaveBeenCalledTimes(1);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
  });

  it('does not allocate if the identity snapshot cannot be durably saved', async () => {
    vi.spyOn(memory.repository, 'save').mockRejectedValueOnce(
      new Error('unsafe token in SQL parameters'),
    );
    await expect(service.createDraft(draftInput())).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      message: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(inventory.createHold).not.toHaveBeenCalled();
    expect([...memory.rows.values()][0].passengerSnapshot).toBeNull();
  });

  it('maps passenger conflicts to only a submitted ref and persisted mask, not upstream secrets', async () => {
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.ABORTED,
      details: JSON.stringify({
        code: ErrorCode.PASSENGER_OVERLAP,
        details: [
          {
            field: 'passengerRefs',
            rejectedValue: { passengerRef: PASSENGER_IDS[0] },
            issueKey: 'ISSUE_PASSENGER_ALREADY_BOOKED',
            actionKey: 'ACTION_REMOVE_PASSENGER_OR_PICK_ANOTHER_TRAIN',
          },
        ],
        // Junk a well-behaved service would not send, and we must not relay.
        nationalId: '29001010112345',
        passengerToken: 'secret',
      }),
      message: 'secret sql',
    });
    try {
      await service.createDraft(draftInput());
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: ErrorCode.PASSENGER_OVERLAP,
        passengerRef: PASSENGER_IDS[0],
        maskedNationalId: '**********1000',
        message: ErrorCode.PASSENGER_OVERLAP,
      });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(JSON.stringify(error)).not.toContain('29001010112345');
    }
  });

  it('does not disclose foreign passenger refs from upstream errors', async () => {
    vi.mocked(inventory.createHold).mockRejectedValue({
      details: JSON.stringify({
        code: ErrorCode.PASSENGER_OVERLAP,
        details: [
          {
            field: 'passengerRefs',
            rejectedValue: { passengerRef: randomUUID() },
            issueKey: 'ISSUE_PASSENGER_ALREADY_BOOKED',
            actionKey: 'ACTION_REMOVE_PASSENGER_OR_PICK_ANOTHER_TRAIN',
          },
        ],
      }),
    });
    await expect(service.createDraft(draftInput())).rejects.toMatchObject({
      code: ErrorCode.PASSENGER_OVERLAP,
      passengerRef: undefined,
      maskedNationalId: undefined,
    });
  });

  it('owner-scopes GET, release and extension before any Inventory work', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    expect(await service.getDraft(dto.bookingKey, OTHER_OWNER_ID)).toBeNull();
    await expect(
      service.releaseHold(OTHER_OWNER_ID, dto.bookingKey),
    ).rejects.toMatchObject({ code: ErrorCode.HOLD_NOT_FOUND });
    await expect(
      service.extendHold(OTHER_OWNER_ID, dto.bookingKey),
    ).rejects.toMatchObject({ code: ErrorCode.HOLD_NOT_FOUND });
    expect(inventory.getHold).not.toHaveBeenCalled();
    expect(inventory.releaseHold).not.toHaveBeenCalled();
    expect(inventory.extendHold).not.toHaveBeenCalled();
  });

  it('reconciles expiry on GET using Inventory, never a new local TTL', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    vi.mocked(inventory.getHold).mockResolvedValue({
      ...inventorySnapshot(createRequest(dto)),
      state: 'EXPIRED',
      version: 2,
    });
    expect(await service.getDraft(dto.bookingKey, OWNER_ID)).toMatchObject({
      status: 'CANCELLED',
      holdState: 'EXPIRED',
      holdVersion: 2,
      expiresAt: new Date(EXPIRES_AT),
    });
  });

  it('returns dependency failure instead of claiming a stale cached live hold on GET', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    vi.mocked(inventory.getHold).mockRejectedValue({
      code: status.UNAVAILABLE,
      message: 'unsafe',
    });
    await expect(
      service.getDraft(dto.bookingKey, OWNER_ID),
    ).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });
  });

  it('durably cancels an unknown create outcome and never retries CreateHold afterward', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockRejectedValue({
      code: status.DEADLINE_EXCEEDED,
    });
    await service.createDraft(dto);
    vi.mocked(inventory.releaseHold).mockResolvedValue({
      ...inventorySnapshot(createRequest(dto)),
      state: 'CANCELLED',
      expiresAt: null,
      allocationOutcome: null,
      legs: [],
      assignments: [],
    });
    expect(await service.releaseHold(OWNER_ID, dto.bookingKey)).toMatchObject({
      status: 'CANCELLED',
      holdState: 'CANCELLED',
      expiresAt: null,
    });
    await service.createDraft(dto);
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
    expect(memory.rows.get(dto.bookingKey)!.releaseRequested).toBe(true);
  });

  it('keeps a timed-out release durable and retries release, not allocation', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    vi.mocked(inventory.releaseHold).mockRejectedValueOnce({
      code: status.DEADLINE_EXCEEDED,
    });
    expect(await service.releaseHold(OWNER_ID, dto.bookingKey)).toMatchObject({
      reconciliationPending: true,
    });
    vi.mocked(inventory.releaseHold).mockResolvedValue({
      ...inventorySnapshot(createRequest(dto)),
      state: 'RELEASED',
      version: 2,
    });
    expect(await service.getDraft(dto.bookingKey, OWNER_ID)).toMatchObject({
      status: 'CANCELLED',
      holdState: 'RELEASED',
    });
    expect(inventory.createHold).toHaveBeenCalledTimes(1);
  });

  it('exposes only an internal owner/key extension with authoritative expiry', async () => {
    const dto = draftInput();
    await service.createDraft(dto);
    const extended = {
      ...inventorySnapshot(createRequest(dto)),
      extensionUsed: true,
      version: 2,
      expiresAt: '2026-11-15T17:11:00.000Z',
    };
    vi.mocked(inventory.extendHold).mockResolvedValue(extended);
    expect(await service.extendHold(OWNER_ID, dto.bookingKey)).toMatchObject({
      extensionUsed: true,
      holdVersion: 2,
      expiresAt: new Date(extended.expiresAt),
    });
    expect(inventory.extendHold).toHaveBeenCalledWith(
      { ownerId: OWNER_ID, bookingKey: dto.bookingKey },
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not resurrect an expiry event that arrives before the create response is saved', async () => {
    const dto = draftInput();
    vi.mocked(inventory.createHold).mockImplementation(
      async (request: CreateHoldRequest) => {
        const held = inventorySnapshot(request);
        await memory.store.applyEvent(
          holdEvent(
            { ...held, state: 'EXPIRED', version: 2 },
            HOLD_EXPIRED_EVENT_TYPE,
            'expired',
          ).payload,
        );
        return held;
      },
    );
    const result = await service.createDraft(dto);
    expect(result).toMatchObject({
      status: 'CANCELLED',
      holdState: 'EXPIRED',
      holdVersion: 2,
    });
    expect(memory.rows.get(dto.bookingKey)).toMatchObject({
      holdVersion: 2,
      holdSnapshot: null,
    });
  });

  it('fails closed when a private credential is absent', async () => {
    vi.stubEnv('BOOKING_IDENTITY_SERVICE_KEY', '');
    await expect(service.createDraft(draftInput())).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(identity.resolveHoldPassengers).not.toHaveBeenCalled();
    expect(inventory.createHold).not.toHaveBeenCalled();
  });
});
