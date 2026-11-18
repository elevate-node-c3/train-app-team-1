import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { ErrorCode, type ResolveHoldPassengersRequest } from '@app/contracts';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  holdPassengerTokenSettingsFromEnv,
  type HoldPassengerTokenSettings,
} from '../../../config/hold-passenger-token-settings.js';
import { AuthError } from '../auth-error.js';
import { HoldPassengerTripKeyEntity } from '../entities/hold-passenger-trip-key.entity.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { HoldPassengerTripKeyRepository } from '../repositories/hold-passenger-trip-key.repository.js';
import { PassengerRepository } from '../repositories/passenger.repository.js';
import { HoldPassengersService } from './hold-passengers.service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const COMPANION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const TRIP = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const OTHER_TRIP = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const NATIONAL_ID = '28505150101235';
const EASTERN_NATIONAL_ID = NATIONAL_ID.replace(/\d/g, (digit) =>
  String.fromCharCode(0x660 + Number(digit)),
);
const KEY_ONE = Buffer.alloc(32, 0x31);
const KEY_TWO = Buffer.alloc(32, 0x32);

function request(
  overrides: Partial<ResolveHoldPassengersRequest> = {},
): ResolveHoldPassengersRequest {
  return {
    ownerId: OWNER,
    passengerRefs: [SELF],
    tripIds: [TRIP],
    ...overrides,
  };
}

function settings(activeVersion = 1): HoldPassengerTokenSettings {
  return holdPassengerTokenSettingsFromEnv({
    HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify({
      1: KEY_ONE.toString('base64'),
      2: KEY_TWO.toString('base64'),
    }),
    HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: String(activeVersion),
  });
}

function row(overrides: Partial<PassengerEntity> = {}): PassengerEntity {
  return Object.assign(new PassengerEntity(), {
    id: SELF,
    accountId: OWNER,
    fullName: 'Ahmed Hussein',
    nationalId: NATIONAL_ID,
    profileType: 'Regular',
    nationality: 'Egyptian',
    isSelf: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

function harness(
  rows = [
    row(),
    row({
      id: COMPANION,
      nationalId: '28505150101234',
      fullName: 'Mona Hussein',
      isSelf: false,
    }),
    row({
      id: FOREIGN,
      accountId: OTHER_OWNER,
      nationalId: EASTERN_NATIONAL_ID,
      isSelf: false,
    }),
  ],
) {
  const ctx: TransactionContext = { driver: 'test' };
  const unitOfWork: UnitOfWorkPort = {
    withTransaction: async <T>(
      work: (context: TransactionContext) => Promise<T>,
    ): Promise<T> => work(ctx),
  };
  vi.spyOn(unitOfWork, 'withTransaction');
  const passengers = new PassengerRepository(
    new DataSource({ type: 'postgres' }),
  );
  const findOwned = vi
    .spyOn(passengers, 'findByIdAndAccountId')
    .mockImplementation(async (received, id, ownerId, options) => {
      expect(received).toBe(ctx);
      expect(options).toEqual({ forUpdate: true });
      return (
        rows.find(
          (passenger) => passenger.id === id && passenger.accountId === ownerId,
        ) ?? null
      );
    });
  const tripKeys = new HoldPassengerTripKeyRepository();
  const pins = new Map<string, HoldPassengerTripKeyEntity>();
  const getOrPin = vi
    .spyOn(tripKeys, 'getOrPin')
    .mockImplementation(
      async (received, tripId, keyVersion, keyFingerprint) => {
        expect(received).toBe(ctx);
        if (!pins.has(tripId)) {
          pins.set(
            tripId,
            Object.assign(new HoldPassengerTripKeyEntity(), {
              tripId,
              keyVersion,
              keyFingerprint,
              pinnedAt: new Date(),
            }),
          );
        }
        return pins.get(tripId)!;
      },
    );
  const serviceFor = (config: HoldPassengerTokenSettings) =>
    new HoldPassengersService(unitOfWork, passengers, tripKeys, config);
  return {
    service: serviceFor(settings()),
    serviceFor,
    unitOfWork,
    findOwned,
    getOrPin,
    pins,
    rows,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('HoldPassengersService', () => {
  it('issues equal canonical-ID tokens across accounts without exporting the ID', async () => {
    const { service } = harness();
    const first = await service.resolve(request());
    const second = await service.resolve(
      request({ ownerId: OTHER_OWNER, passengerRefs: [FOREIGN] }),
    );
    const expected = createHmac('sha256', KEY_ONE)
      .update(`hold-passenger:v1\0${TRIP}\0${NATIONAL_ID}`)
      .digest('hex');
    expect(first.passengers[0].identities).toEqual(
      second.passengers[0].identities,
    );
    expect(first.passengers[0]).toEqual({
      passengerRef: SELF,
      displayName: 'Ahmed Hussein',
      maskedNationalId: '**********1235',
      identities: [
        { tripId: TRIP, passengerKeyVersion: 1, passengerToken: expected },
      ],
    });
    expect(second.passengers[0].maskedNationalId).toMatch(/^\*{10}\d{4}$/);
    expect(second.passengers[0].maskedNationalId).toHaveLength(14);
    expect(JSON.stringify([first, second])).not.toContain(NATIONAL_ID);
    expect(JSON.stringify([first, second])).not.toContain(EASTERN_NATIONAL_ID);
    expect(JSON.stringify([first, second])).not.toContain(
      KEY_ONE.toString('base64'),
    );
  });

  it('separates dated trips and distinct canonical IDs', async () => {
    const { service } = harness();
    const result = await service.resolve(
      request({
        passengerRefs: [SELF, COMPANION],
        tripIds: [TRIP, OTHER_TRIP],
      }),
    );
    const tokens = result.passengers.flatMap((passenger) =>
      passenger.identities.map((identity) => identity.passengerToken),
    );
    expect(new Set(tokens).size).toBe(4);
    expect(tokens.every((token) => /^[0-9a-f]{64}$/.test(token))).toBe(true);
  });

  it('accepts four owned saved/self rows and preserves submitted order and UUID spelling', async () => {
    const extra = [
      row({ id: randomUUID(), isSelf: false }),
      row({ id: randomUUID(), isSelf: false }),
    ];
    const { service, findOwned, getOrPin } = harness([
      row(),
      row({ id: COMPANION, isSelf: false }),
      ...extra,
    ]);
    const passengerRefs = [
      extra[1].id,
      SELF.toUpperCase(),
      COMPANION,
      extra[0].id,
    ];
    const tripIds = [OTHER_TRIP.toUpperCase(), TRIP];
    const result = await service.resolve(request({ passengerRefs, tripIds }));
    expect(
      result.passengers.map((passenger) => passenger.passengerRef),
    ).toEqual(passengerRefs);
    expect(
      result.passengers[0].identities.map((identity) => identity.tripId),
    ).toEqual(tripIds);
    expect(findOwned.mock.calls.map((call) => call[1])).toEqual(
      passengerRefs.map((ref) => ref.toLowerCase()).sort(),
    );
    expect(getOrPin.mock.calls.map((call) => call[1])).toEqual(
      [TRIP, OTHER_TRIP].sort(),
    );
  });

  it('normalizes trip UUID case for token comparison, not just for database lookup', async () => {
    const { service } = harness();
    const lower = await service.resolve(request());
    const upper = await service.resolve(
      request({
        passengerRefs: [SELF.toUpperCase()],
        tripIds: [TRIP.toUpperCase()],
      }),
    );
    expect(upper.passengers[0].identities[0].passengerToken).toBe(
      lower.passengers[0].identities[0].passengerToken,
    );
  });

  it('only issues comparisons for duplicate canonical IDs; Inventory owns overlap enforcement', async () => {
    const { service } = harness([
      row(),
      row({ id: COMPANION, nationalId: EASTERN_NATIONAL_ID, isSelf: false }),
    ]);
    const result = await service.resolve(
      request({ passengerRefs: [SELF, COMPANION] }),
    );
    expect(result.passengers[0].identities).toEqual(
      result.passengers[1].identities,
    );
  });

  it.each([FOREIGN, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'])(
    'conceals missing and foreign refs with the same failure (%#)',
    async (ref) => {
      const { service, getOrPin } = harness();
      await expect(
        service.resolve(request({ passengerRefs: [SELF, ref] })),
      ).rejects.toMatchObject({ code: ErrorCode.PASSENGER_NOT_FOUND });
      expect(getOrPin).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ownerId: '' },
    { ownerId: NATIONAL_ID },
    { passengerRefs: [] },
    { passengerRefs: Array.from({ length: 5 }, () => randomUUID()) },
    { passengerRefs: [SELF, SELF] },
    { passengerRefs: [SELF, SELF.toUpperCase()] },
    { passengerRefs: [NATIONAL_ID] },
    { tripIds: [] },
    { tripIds: [TRIP, OTHER_TRIP, randomUUID()] },
    { tripIds: [TRIP, TRIP] },
    { tripIds: [TRIP, TRIP.toUpperCase()] },
    { tripIds: ['not-a-trip-uuid'] },
  ])(
    'rejects invalid references/counts before database work (%#)',
    async (input) => {
      const { service, unitOfWork, findOwned, getOrPin } = harness();
      await expect(service.resolve(request(input))).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
      expect(unitOfWork.withTransaction).not.toHaveBeenCalled();
      expect(findOwned).not.toHaveBeenCalled();
      expect(getOrPin).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['', ErrorCode.INVALID_NATIONAL_ID_LENGTH],
    ['48505150101235', ErrorCode.INVALID_NATIONAL_ID_CENTURY],
    ['28502300101235', ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE],
    ['28505159901235', ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE],
  ])(
    'rejects invalid saved National IDs without pinning or disclosing values (%#)',
    async (nationalId, code) => {
      const { service, getOrPin } = harness([row({ nationalId })]);
      await expect(service.resolve(request())).rejects.toMatchObject({
        code,
        message: code,
      });
      expect(getOrPin).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid saved display names using the existing validator', async () => {
    const { service, getOrPin } = harness([row({ fullName: NATIONAL_ID })]);
    await expect(service.resolve(request())).rejects.toMatchObject({
      code: ErrorCode.INVALID_FULL_NAME,
    });
    expect(getOrPin).not.toHaveBeenCalled();
  });

  it('keeps an existing trip version/token after rotation and uses the new key only on new trips', async () => {
    const { service, serviceFor, pins } = harness();
    const first = await service.resolve(request());
    const rotated = serviceFor(settings(2));
    expect(await rotated.resolve(request())).toEqual(first);
    const next = await rotated.resolve(request({ tripIds: [OTHER_TRIP] }));
    expect(next.passengers[0].identities[0].passengerKeyVersion).toBe(2);
    expect(pins.get(TRIP)?.keyVersion).toBe(1);
    expect(pins.get(TRIP)?.keyFingerprint).toBe(
      createHash('sha256').update(KEY_ONE).digest('hex'),
    );
  });

  it('fails closed with no configured keys before opening a transaction', async () => {
    const { serviceFor, unitOfWork } = harness();
    await expect(
      serviceFor(holdPassengerTokenSettingsFromEnv({})).resolve(request()),
    ).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
    expect(unitOfWork.withTransaction).not.toHaveBeenCalled();
  });

  it.each(['missing', 'short', 'changed'] as const)(
    'never substitutes an active key for an unusable pinned key (%s)',
    async (kind) => {
      const { service, serviceFor, pins } = harness();
      await service.resolve(request());
      const keys = new Map([[2, KEY_TWO]]);
      if (kind !== 'missing')
        keys.set(
          1,
          kind === 'short' ? Buffer.alloc(31) : Buffer.alloc(32, 0x73),
        );
      const changed = serviceFor({ activeVersion: 2, keys });
      await expect(changed.resolve(request())).rejects.toMatchObject({
        code: ErrorCode.SERVICE_UNAVAILABLE,
        message: ErrorCode.SERVICE_UNAVAILABLE,
      });
      expect(pins.get(TRIP)?.keyVersion).toBe(1);
      expect(pins.get(TRIP)?.keyFingerprint).toBe(
        createHash('sha256').update(KEY_ONE).digest('hex'),
      );
    },
  );

  it('redacts database failures and logs no National ID or key material', async () => {
    const { service, findOwned } = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    findOwned.mockRejectedValueOnce(
      new Error(`query failed: ${NATIONAL_ID} ${KEY_ONE.toString('base64')}`),
    );
    await expect(service.resolve(request())).rejects.toEqual(
      new AuthError(ErrorCode.SERVICE_UNAVAILABLE),
    );
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
