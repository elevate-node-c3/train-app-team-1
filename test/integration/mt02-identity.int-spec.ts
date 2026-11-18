import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { ErrorCode, type ResolveHoldPassengersRequest } from '@app/contracts';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import {
  holdPassengerTokenSettingsFromEnv,
  type HoldPassengerTokenSettings,
} from '../../apps/identity/src/config/hold-passenger-token-settings.js';
import {
  encryptNationalId,
  nationalIdBlindIndex,
} from '../../apps/identity/src/config/national-id-vault.js';
import {
  IDENTITY_MIGRATIONS,
  CreateHoldPassengerTripKeys1794764000000,
  EncryptNationalIds1794765000000,
} from '../../apps/identity/src/database/migrations/index.js';
import { AccountEntity } from '../../apps/identity/src/modules/auth/entities/account.entity.js';
import { HoldPassengerTripKeyEntity } from '../../apps/identity/src/modules/auth/entities/hold-passenger-trip-key.entity.js';
import { PassengerEntity } from '../../apps/identity/src/modules/auth/entities/passenger.entity.js';
import { AccountRepository } from '../../apps/identity/src/modules/auth/repositories/account.repository.js';
import { HoldPassengerTripKeyRepository } from '../../apps/identity/src/modules/auth/repositories/hold-passenger-trip-key.repository.js';
import { PassengerRepository } from '../../apps/identity/src/modules/auth/repositories/passenger.repository.js';
import { HoldPassengersService } from '../../apps/identity/src/modules/auth/services/hold-passengers.service.js';

const schema = `mt02_identity_${randomUUID().replace(/-/g, '')}`;
const contenderName = `${schema}_contender`;
const keyOne = randomBytes(32);
const keyTwo = randomBytes(32);
const encryptionKey = randomBytes(32);
const blindIndexKey = randomBytes(32);
const nationalId = '28505150101235';
const easternNationalId = nationalId.replace(/\d/g, (digit) =>
  String.fromCharCode(0x660 + Number(digit)),
);
let admin: DataSource;
let source: DataSource;
let contender: DataSource;
let createdSchema = false;
let upgraded: string[];
let legacy: { ownerId: string; passengerRef: string };
let encryptedStorage = false;

function isolatedIdentityUrl(): string {
  const value = process.env.IDENTITY_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'IDENTITY_TEST_DATABASE_URL must explicitly target the isolated MT-02 Identity database.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid IDENTITY_TEST_DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '25432' ||
    url.pathname !== '/identity' ||
    url.username !== 'identity' ||
    url.password !== 'identity_mt02_test_only' ||
    url.search !== ''
  ) {
    throw new Error(
      'Identity tests require the dedicated identity role/database on 127.0.0.1:25432.',
    );
  }
  return value;
}

function database(
  migrations = IDENTITY_MIGRATIONS,
  applicationName = schema,
): DataSource {
  return new DataSource({
    type: 'postgres',
    url: isolatedIdentityUrl(),
    schema,
    entities: [AccountEntity, PassengerEntity, HoldPassengerTripKeyEntity],
    migrations,
    synchronize: false,
    logging: false,
    extra: {
      max: 6,
      options: `-c search_path=${schema}`,
      application_name: applicationName,
    },
  });
}

function settings(
  activeVersion = 1,
  keys: Record<number, string> = {
    1: keyOne.toString('base64'),
    2: keyTwo.toString('base64'),
  },
): HoldPassengerTokenSettings {
  return holdPassengerTokenSettingsFromEnv({
    HOLD_PASSENGER_TOKEN_KEYS: JSON.stringify(keys),
    HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: String(activeVersion),
  });
}

function resolver(
  connection = source,
  config = settings(),
): HoldPassengersService {
  return new HoldPassengersService(
    new TypeOrmUnitOfWork(new DataSourceInitializer(connection)),
    new PassengerRepository(connection),
    new HoldPassengerTripKeyRepository(),
    config,
  );
}

async function seedPassenger(
  options: { ownerId?: string; nationalId?: string; isSelf?: boolean } = {},
): Promise<{ ownerId: string; passengerRef: string }> {
  const ownerId = options.ownerId ?? randomUUID();
  const passengerRef = randomUUID();
  const plainNationalId = options.nationalId ?? nationalId;
  const passengerNationalId = encryptedStorage
    ? encryptNationalId(plainNationalId, 'passenger')
    : plainNationalId;
  const passengerHash = encryptedStorage
    ? nationalIdBlindIndex(plainNationalId)
    : null;
  // Deliberately not bookable: Identity is not a second admission guard.
  if (encryptedStorage) {
    await source.query(
      `INSERT INTO account (id, email, status, bookable, national_id, national_id_hash)
       VALUES ($1, $2, 'active', false, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        ownerId,
        `${ownerId}@mt02-identity.invalid`,
        options.isSelf ? encryptNationalId(plainNationalId, 'account') : null,
        options.isSelf ? nationalIdBlindIndex(plainNationalId) : null,
      ],
    );
    await source.query(
      `INSERT INTO passenger
         (id, account_id, full_name, national_id, national_id_hash, profile_type, nationality, is_self)
       VALUES ($1, $2, 'Ahmed Hussein', $3, $4, 'Regular', 'Egyptian', $5)`,
      [
        passengerRef,
        ownerId,
        passengerNationalId,
        passengerHash,
        options.isSelf ?? false,
      ],
    );
  } else {
    await source.query(
      `INSERT INTO account (id, email, status, bookable, national_id)
       VALUES ($1, $2, 'active', false, $3) ON CONFLICT (id) DO NOTHING`,
      [
        ownerId,
        `${ownerId}@mt02-identity.invalid`,
        options.isSelf ? plainNationalId : null,
      ],
    );
    await source.query(
      `INSERT INTO passenger
         (id, account_id, full_name, national_id, profile_type, nationality, is_self)
       VALUES ($1, $2, 'Ahmed Hussein', $3, 'Regular', 'Egyptian', $4)`,
      [passengerRef, ownerId, plainNationalId, options.isSelf ?? false],
    );
  }
  return { ownerId, passengerRef };
}

function request(
  passenger: { ownerId: string; passengerRef: string },
  tripIds: string[] = [randomUUID()],
): ResolveHoldPassengersRequest {
  return {
    ownerId: passenger.ownerId,
    passengerRefs: [passenger.passengerRef],
    tripIds,
  };
}

beforeAll(async () => {
  vi.stubEnv('NATIONAL_ID_ACTIVE_KEY_VERSION', '1');
  vi.stubEnv(
    'NATIONAL_ID_ENCRYPTION_KEYS',
    JSON.stringify({ 1: encryptionKey.toString('base64') }),
  );
  vi.stubEnv('NATIONAL_ID_BLIND_INDEX_KEY', blindIndexKey.toString('base64'));
  admin = new DataSource({
    type: 'postgres',
    url: isolatedIdentityUrl(),
    synchronize: false,
    logging: false,
  });
  await admin.initialize();
  const [identity]: { database: string; role: string }[] = await admin.query(
    'SELECT current_database() AS database, current_user AS role',
  );
  expect(identity).toEqual({ database: 'identity', role: 'identity' });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;

  source = database(
    IDENTITY_MIGRATIONS.filter(
      (migration) =>
        migration !== CreateHoldPassengerTripKeys1794764000000 &&
        migration !== EncryptNationalIds1794765000000,
    ),
  );
  await source.initialize();
  await source.runMigrations({ transaction: 'all' });
  legacy = await seedPassenger({ isSelf: true });
  await source.destroy();

  source = database();
  await source.initialize();
  upgraded = (await source.runMigrations({ transaction: 'all' })).map(
    (migration) => migration.name,
  );
  encryptedStorage = true;
  contender = database(IDENTITY_MIGRATIONS, contenderName);
  await contender.initialize();
});

afterAll(async () => {
  if (contender?.isInitialized) await contender.destroy();
  if (source?.isInitialized) await source.destroy();
  if (admin?.isInitialized) {
    // No truncation of shared service tables: remove only this run's schema.
    if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.destroy();
  }
  vi.unstubAllEnvs();
});

describe('MT-02 Identity real PostgreSQL prerequisite', () => {
  it('upgrades the existing schema forward without rewriting profiles and registers the pin entity', async () => {
    expect(upgraded).toEqual([
      'CreateHoldPassengerTripKeys1794764000000',
      'EncryptNationalIds1794765000000',
    ]);
    const passenger = await source
      .getRepository(PassengerEntity)
      .findOneByOrFail({ id: legacy.passengerRef });
    expect(passenger.nationalId).toBe(nationalId);
    expect(passenger.fullName).toBe('Ahmed Hussein');
    expect(passenger.accountId).toBe(legacy.ownerId);
    expect(passenger.isSelf).toBe(true);
    const [storedPassenger]: { nationalId: string; hash: string }[] =
      await source.query(
        `SELECT national_id AS "nationalId", national_id_hash AS hash FROM passenger WHERE id = $1`,
        [legacy.passengerRef],
      );
    const [storedAccount]: { nationalId: string; hash: string }[] =
      await source.query(
        `SELECT national_id AS "nationalId", national_id_hash AS hash FROM account WHERE id = $1`,
        [legacy.ownerId],
      );
    expect(storedPassenger.nationalId).not.toContain(nationalId);
    expect(storedAccount.nationalId).not.toContain(nationalId);
    expect(storedPassenger.nationalId).not.toContain('**********1235');
    expect(storedPassenger.hash).toBe(nationalIdBlindIndex(nationalId));
    expect(storedAccount.hash).toBe(storedPassenger.hash);
    expect(source.getMetadata(HoldPassengerTripKeyEntity).tableName).toBe(
      'hold_passenger_trip_key',
    );
    expect(await source.runMigrations({ transaction: 'all' })).toEqual([]);
  });

  it('refuses trip-key rollback while immutable token pins exist and changes nothing', async () => {
    const tripId = randomUUID();
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `INSERT INTO hold_passenger_trip_key (trip_id, key_version, key_fingerprint)
         VALUES ($1, 1, $2)`,
        [tripId, 'a'.repeat(64)],
      );
      await expect(
        new CreateHoldPassengerTripKeys1794764000000().down(runner),
      ).rejects.toThrow('Cannot roll back MT-02 passenger-token key pins');
      const [state]: {
        pins: string;
        tableName: string;
        triggerName: string;
      }[] = await runner.query(`
          SELECT
            (SELECT count(*)::text FROM hold_passenger_trip_key) AS pins,
            to_regclass('hold_passenger_trip_key')::text AS "tableName",
            (SELECT tgname FROM pg_trigger
             WHERE tgrelid = 'hold_passenger_trip_key'::regclass
               AND tgname = 'trg_hold_passenger_trip_key_immutable') AS "triggerName"
        `);
      expect(state).toEqual({
        pins: '1',
        tableName: 'hold_passenger_trip_key',
        triggerName: 'trg_hold_passenger_trip_key_immutable',
      });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('allows trip-key rollback only when no pins exist', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await new CreateHoldPassengerTripKeys1794764000000().down(runner);
      const [inside]: {
        tableName: string | null;
        functionName: string | null;
      }[] = await runner.query(`
          SELECT to_regclass('hold_passenger_trip_key')::text AS "tableName",
                 to_regprocedure('reject_hold_passenger_trip_key_change()')::text AS "functionName"
        `);
      expect(inside).toEqual({ tableName: null, functionName: null });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    const [restored]: { tableName: string }[] = await source.query(
      `SELECT to_regclass('hold_passenger_trip_key')::text AS "tableName"`,
    );
    expect(restored.tableName).toBe('hold_passenger_trip_key');
  });

  it('refuses encrypted National-ID rollback without restoring plaintext or changing schema', async () => {
    const rollbackNationalId = '28505150101236';
    const saved = await seedPassenger({
      isSelf: true,
      nationalId: rollbackNationalId,
    });
    const [before]: {
      accountNid: string;
      passengerNid: string;
      accountHash: string;
      passengerHash: string;
    }[] = await source.query(
      `SELECT a.national_id AS "accountNid", p.national_id AS "passengerNid",
              a.national_id_hash AS "accountHash", p.national_id_hash AS "passengerHash"
       FROM account a JOIN passenger p ON p.account_id = a.id
       WHERE a.id = $1 AND p.id = $2`,
      [saved.ownerId, saved.passengerRef],
    );
    const runner = source.createQueryRunner();
    await runner.connect();
    try {
      await expect(
        new EncryptNationalIds1794765000000().down(runner),
      ).rejects.toThrow('National-ID encryption is irreversible');
    } finally {
      await runner.release();
    }
    const [after]: (typeof before)[] = await source.query(
      `SELECT a.national_id AS "accountNid", p.national_id AS "passengerNid",
              a.national_id_hash AS "accountHash", p.national_id_hash AS "passengerHash"
       FROM account a JOIN passenger p ON p.account_id = a.id
       WHERE a.id = $1 AND p.id = $2`,
      [saved.ownerId, saved.passengerRef],
    );
    expect(after).toEqual(before);
    expect(after.accountNid).toMatch(/^nid:v1:/);
    expect(after.passengerNid).toMatch(/^nid:v1:/);
    expect(after.accountNid).not.toContain(rollbackNationalId);
    const columns: { tableName: string; columnName: string }[] =
      await source.query(`
        SELECT table_name AS "tableName", column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('account', 'passenger')
          AND column_name = 'national_id_hash'
        ORDER BY table_name
      `);
    expect(columns).toEqual([
      { tableName: 'account', columnName: 'national_id_hash' },
      { tableName: 'passenger', columnName: 'national_id_hash' },
    ]);
  });

  it('resolves owned self/saved rows with equal canonical IDs across accounts and different dated-trip tokens', async () => {
    const saved = await seedPassenger({ nationalId: easternNationalId });
    const tripIds = [randomUUID(), randomUUID()];
    const first = await resolver().resolve(request(legacy, tripIds));
    const second = await resolver(contender).resolve(request(saved, tripIds));
    expect(first.passengers[0].identities).toEqual(
      second.passengers[0].identities,
    );
    expect(first.passengers[0].identities[0].passengerToken).not.toBe(
      first.passengers[0].identities[1].passengerToken,
    );
    expect(second.passengers[0].maskedNationalId).toBe('**********1235');
    expect(second.passengers[0].maskedNationalId).toHaveLength(14);
    expect(JSON.stringify([first, second])).not.toContain(nationalId);
    expect(JSON.stringify([first, second])).not.toContain(easternNationalId);
    expect(JSON.stringify([first, second])).not.toContain(
      keyOne.toString('base64'),
    );
    expect(
      await source
        .getRepository(HoldPassengerTripKeyEntity)
        .count({ where: { tripId: tripIds[0] } }),
    ).toBe(1);
  });

  it('encrypts new account/passenger writes and looks up canonical variants by blind index', async () => {
    const ownerId = randomUUID();
    const passengerRef = randomUUID();
    const secondNationalId = '28505150101234';
    const eastern = secondNationalId.replace(/\d/g, (digit) =>
      String.fromCharCode(0x660 + Number(digit)),
    );
    await source.query(
      `INSERT INTO account (id, email, status, bookable)
       VALUES ($1, $2, 'active', false)`,
      [ownerId, `${ownerId}@mt02-encrypted.invalid`],
    );
    const initializer = new DataSourceInitializer(source);
    const unitOfWork = new TypeOrmUnitOfWork(initializer);
    const accounts = new AccountRepository(source);
    const passengers = new PassengerRepository(source);
    await unitOfWork.withTransaction(async (ctx) => {
      const account = await accounts.findByIdForUpdate(ctx, ownerId);
      expect(account).not.toBeNull();
      account!.nationalId = eastern;
      await accounts.update(ctx, account!);
      const passenger = Object.assign(new PassengerEntity(), {
        id: passengerRef,
        accountId: ownerId,
        fullName: 'Encrypted Passenger',
        nationalId: eastern,
        profileType: 'Regular',
        nationality: 'Egyptian',
        isSelf: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await passengers.save(ctx, passenger);
      expect(
        await passengers.findByAccountAndNationalId(
          ctx,
          ownerId,
          secondNationalId,
        ),
      ).toMatchObject({ nationalId: secondNationalId });
    });
    const [stored]: {
      accountNid: string;
      passengerNid: string;
      accountHash: string;
      passengerHash: string;
    }[] = await source.query(
      `SELECT a.national_id AS "accountNid", p.national_id AS "passengerNid",
                a.national_id_hash AS "accountHash", p.national_id_hash AS "passengerHash"
         FROM account a JOIN passenger p ON p.account_id = a.id
         WHERE a.id = $1 AND p.id = $2`,
      [ownerId, passengerRef],
    );
    expect(stored.accountNid).not.toContain(secondNationalId);
    expect(stored.passengerNid).not.toContain(secondNationalId);
    expect(stored.accountHash).toBe(stored.passengerHash);
    expect(stored.accountHash).toBe(nationalIdBlindIndex(secondNationalId));
  });

  it('does not resolve foreign rows or create a pin when any selected ref is unowned', async () => {
    const first = await seedPassenger();
    const foreign = await seedPassenger();
    const tripId = randomUUID();
    await expect(
      resolver().resolve({
        ...request(first, [tripId]),
        passengerRefs: [first.passengerRef, foreign.passengerRef],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PASSENGER_NOT_FOUND });
    expect(
      await source
        .getRepository(HoldPassengerTripKeyEntity)
        .count({ where: { tripId } }),
    ).toBe(0);
  });

  it('waits for the concurrent first pin and uses the committed winner, not its own active version', async () => {
    const passenger = await seedPassenger();
    const tripId = randomUUID();
    const unitOfWork = new TypeOrmUnitOfWork(new DataSourceInitializer(source));
    const pins = new HoldPassengerTripKeyRepository();
    let releaseWinner!: () => void;
    let signalPinned!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const pinned = new Promise<void>((resolve) => {
      signalPinned = resolve;
    });
    const winner = unitOfWork.withTransaction(async (ctx) => {
      const pin = await pins.getOrPin(
        ctx,
        tripId,
        1,
        createHash('sha256').update(keyOne).digest('hex'),
      );
      signalPinned();
      await released;
      return pin;
    });
    await pinned;
    const waiting = resolver(contender, settings(2)).resolve(
      request(passenger, [tripId]),
    );
    try {
      await vi.waitFor(
        async () => {
          const [locks]: { count: number }[] = await admin.query(
            `SELECT count(*)::integer AS count FROM pg_stat_activity
           WHERE datname = current_database() AND application_name = $1
             AND wait_event_type = 'Lock' AND query LIKE '%hold_passenger_trip_key%'`,
            [contenderName],
          );
          expect(locks.count).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 25 },
      );
      releaseWinner();
      const [pin, response] = await Promise.all([winner, waiting]);
      expect(pin.keyVersion).toBe(1);
      expect(response.passengers[0].identities[0].passengerKeyVersion).toBe(1);
      expect(
        await source
          .getRepository(HoldPassengerTripKeyEntity)
          .count({ where: { tripId } }),
      ).toBe(1);
      expect(await resolver().resolve(request(passenger, [tripId]))).toEqual(
        response,
      );
    } finally {
      releaseWinner();
      await Promise.allSettled([winner, waiting]);
    }
  });

  it('resolves opposing two-trip requests on independent instances without divergent pins or deadlocks', async () => {
    const first = await seedPassenger();
    const second = await seedPassenger({ nationalId: easternNationalId });
    const tripIds = [randomUUID(), randomUUID()];
    const [left, right] = await Promise.all([
      resolver(source, settings(1)).resolve(request(first, tripIds)),
      resolver(contender, settings(2)).resolve(
        request(second, [...tripIds].reverse()),
      ),
    ]);
    for (const identity of left.passengers[0].identities) {
      expect(
        right.passengers[0].identities.find(
          (candidate) => candidate.tripId === identity.tripId,
        ),
      ).toEqual(identity);
      expect(
        await source
          .getRepository(HoldPassengerTripKeyEntity)
          .count({ where: { tripId: identity.tripId } }),
      ).toBe(1);
    }
  });

  it('retains versions across connection restart/rotation and pins new trips to the new active key', async () => {
    const passenger = await seedPassenger();
    const tripIds = [randomUUID()];
    const before = await resolver().resolve(request(passenger, tripIds));
    await contender.destroy();
    contender = database(IDENTITY_MIGRATIONS, contenderName);
    await contender.initialize();
    const rotated = resolver(contender, settings(2));
    expect(await rotated.resolve(request(passenger, tripIds))).toEqual(before);
    const after = await rotated.resolve(request(passenger));
    expect(after.passengers[0].identities[0].passengerKeyVersion).toBe(2);
  });

  it('fails closed for a missing pinned key and rolls back every new pin in the failed request', async () => {
    const passenger = await seedPassenger();
    const oldTrip = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`;
    const newTrip = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    const original = await resolver().resolve(request(passenger, [oldTrip]));
    const missingKey = resolver(
      contender,
      settings(2, { 2: keyTwo.toString('base64') }),
    );
    await expect(
      missingKey.resolve(request(passenger, [newTrip, oldTrip])),
    ).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: ErrorCode.SERVICE_UNAVAILABLE,
    });
    expect(
      await source
        .getRepository(HoldPassengerTripKeyEntity)
        .count({ where: { tripId: newTrip } }),
    ).toBe(0);
    expect(await resolver().resolve(request(passenger, [oldTrip]))).toEqual(
      original,
    );
  });

  it('rejects changed secret material under an existing pinned version', async () => {
    const passenger = await seedPassenger();
    const input = request(passenger);
    const original = await resolver().resolve(input);
    const changedKey = resolver(
      contender,
      settings(2, {
        1: randomBytes(32).toString('base64'),
        2: keyTwo.toString('base64'),
      }),
    );
    await expect(changedKey.resolve(input)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
    expect(await resolver().resolve(input)).toEqual(original);
  });

  it('enforces positive unique immutable trip pins in PostgreSQL itself', async () => {
    const passenger = await seedPassenger();
    const input = request(passenger);
    await resolver().resolve(input);
    const tripId = input.tripIds[0];
    const fingerprint = createHash('sha256').update(keyOne).digest('hex');
    await expect(
      source.query(
        'UPDATE hold_passenger_trip_key SET key_version = 2 WHERE trip_id = $1',
        [tripId],
      ),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        message: 'HOLD_PASSENGER_TRIP_KEY_IMMUTABLE',
      },
    });
    await expect(
      source.query('DELETE FROM hold_passenger_trip_key WHERE trip_id = $1', [
        tripId,
      ]),
    ).rejects.toMatchObject({
      driverError: {
        code: '23514',
        message: 'HOLD_PASSENGER_TRIP_KEY_IMMUTABLE',
      },
    });
    await expect(
      source.query(
        'INSERT INTO hold_passenger_trip_key (trip_id, key_version, key_fingerprint) VALUES ($1, 2, $2)',
        [tripId, fingerprint],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(
      source.query(
        'INSERT INTO hold_passenger_trip_key (trip_id, key_version, key_fingerprint) VALUES ($1, 0, $2)',
        [randomUUID(), fingerprint],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    const pin = await source
      .getRepository(HoldPassengerTripKeyEntity)
      .findOneByOrFail({ tripId });
    expect(pin.keyVersion).toBe(1);
    expect(pin.keyFingerprint).toBe(fingerprint);
  });
});
