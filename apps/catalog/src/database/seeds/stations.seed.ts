import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { In, type EntityManager } from 'typeorm';
import { v5 as uuidv5 } from 'uuid';
import type { StationChangedPayloadV1 } from '@app/contracts/events/catalog-events.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { CatalogModule } from '../../catalog.module.js';
import { withBackgroundJobsDisabled } from '../../config/trip-generation-settings.js';
import { CityEntity } from '../../modules/stations/entities/city.entity.js';
import { GovernorateEntity } from '../../modules/stations/entities/governorate.entity.js';
import { StationEntity } from '../../modules/stations/entities/station.entity.js';
import { StationsService } from '../../modules/stations/stations.service.js';
import { buildStationChanged } from '../../modules/stations/station-events.factory.js';
import { governorates } from './stations.js';

/**
 * Fixed namespace: the same slug always gives the same id, so running the
 * seed again updates rows instead of duplicating them.
 */
const NAMESPACE = '6f1c1d0e-5a4b-4c53-9a47-2d3f9b1e7a10';

/** The caller supplies its transaction's manager and awaits any change callback. */
export async function writeStations(
  manager: EntityManager,
  onChanged?: (payload: StationChangedPayloadV1) => Promise<void>,
): Promise<void> {
  const governorateRows: Pick<
    GovernorateEntity,
    'id' | 'nameAr' | 'nameEn' | 'sortOrder'
  >[] = [];
  const cityRows: Pick<
    CityEntity,
    'id' | 'governorateId' | 'nameAr' | 'nameEn'
  >[] = [];
  const stationRows: Pick<
    StationEntity,
    'id' | 'cityId' | 'nameAr' | 'nameEn' | 'altSpellings'
  >[] = [];
  const legacyIds = new Map<string, string>();

  const idOf = (kind: string, row: { id?: string; slug: string }): string => {
    const legacyId = uuidv5(`${kind}:${row.slug}`, NAMESPACE);
    if (row.id && row.id !== legacyId) legacyIds.set(legacyId, row.id);
    return row.id ?? legacyId;
  };

  governorates.forEach((governorate, index) => {
    const governorateId = idOf('governorate', governorate);
    governorateRows.push({
      id: governorateId,
      nameAr: governorate.nameAr,
      nameEn: governorate.nameEn,
      sortOrder: index + 1,
    });

    for (const city of governorate.cities) {
      const cityId = idOf('city', city);
      cityRows.push({
        id: cityId,
        governorateId,
        nameAr: city.nameAr,
        nameEn: city.nameEn,
      });

      for (const station of city.stations) {
        // Omit isActive: inserts use the default, updates preserve deactivation.
        stationRows.push({
          id: idOf('station', station),
          cityId,
          nameAr: station.nameAr,
          nameEn: station.nameEn,
          altSpellings: station.altSpellings ?? [],
        });
      }
    }
  });

  // Keep old station snapshots stable while parking the unique governorate
  // orders. Both table locks are released by the caller's transaction.
  await manager.query(
    'LOCK TABLE "governorate", "station" IN SHARE ROW EXCLUSIVE MODE',
  );
  const governorateRepository = manager.getRepository(GovernorateEntity);
  const cityRepository = manager.getRepository(CityEntity);
  const stationRepository = manager.getRepository(StationEntity);
  const existingGovernorates = await governorateRepository.find({
    select: { id: true, sortOrder: true },
    order: { sortOrder: 'ASC', id: 'ASC' },
  });
  const legacyCities = await cityRepository.find({
    select: { id: true },
    where: { id: In([...legacyIds.keys()]) },
  });
  const existingStations = await stationRepository.find({
    select: {
      id: true,
      cityId: true,
      nameAr: true,
      nameEn: true,
      altSpellings: true,
      isActive: true,
    },
    where: {
      id: In([...stationRows.map((row) => row.id), ...legacyIds.keys()]),
    },
  });
  const legacyRows = [
    ...existingGovernorates,
    ...legacyCities,
    ...existingStations,
  ].filter((row) => legacyIds.has(row.id));
  if (legacyRows.length > 0) {
    throw new Error(
      `Station seed requires manual reconciliation of legacy IDs before writing: ${legacyRows
        .map((row) => `${row.id} => ${legacyIds.get(row.id)}`)
        .join(', ')}. No legacy rows have been deleted or re-keyed.`,
    );
  }

  const previousStations = new Map(
    existingStations.map((row) => [row.id, row]),
  );
  for (const row of stationRows) {
    row.altSpellings = [
      ...new Set([
        ...row.altSpellings,
        ...(previousStations.get(row.id)?.altSpellings ?? []),
      ]),
    ];
  }

  const seededIds = new Set(governorateRows.map((row) => row.id));
  const unrelatedGovernorates = existingGovernorates.filter(
    (row) => !seededIds.has(row.id),
  );
  const occupiedOrders = new Set(
    existingGovernorates.map((row) => row.sortOrder),
  );
  let temporaryOrder = -1;
  for (const row of existingGovernorates) {
    while (occupiedOrders.has(temporaryOrder)) temporaryOrder--;
    await governorateRepository.update(row.id, { sortOrder: temporaryOrder });
    occupiedOrders.add(temporaryOrder--);
  }

  await governorateRepository.upsert(governorateRows, ['id']);
  // A dense tail preserves unrelated rows' relative order without repeat growth.
  for (const [index, row] of unrelatedGovernorates.entries()) {
    await governorateRepository.update(row.id, {
      sortOrder: governorates.length + index + 1,
    });
  }
  await cityRepository.upsert(cityRows, ['id']);
  await stationRepository.upsert(stationRows, ['id']);

  if (onChanged) {
    for (const row of stationRows) {
      const previous = previousStations.get(row.id);
      if (
        previous &&
        previous.nameAr === row.nameAr &&
        previous.nameEn === row.nameEn &&
        previous.cityId === row.cityId &&
        previous.altSpellings.length === row.altSpellings.length &&
        previous.altSpellings.every(
          (alias, index) => alias === row.altSpellings[index],
        )
      )
        continue;

      const city = cityRows.find((city) => city.id === row.cityId)!;
      const governorate = governorateRows.find(
        (governorate) => governorate.id === city.governorateId,
      )!;
      await onChanged({
        stationId: row.id,
        action: previous ? 'updated' : 'created',
        nameAr: row.nameAr,
        nameEn: row.nameEn,
        cityId: city.id,
        governorateId: governorate.id,
        cityName: { ar: city.nameAr, en: city.nameEn },
        governorateName: { ar: governorate.nameAr, en: governorate.nameEn },
        altSpellings: row.altSpellings,
        isActive: previous?.isActive ?? true,
      });
    }
  }
}

export async function seedStations(
  app: INestApplicationContext,
): Promise<void> {
  const outbox = app.get<OutboxPort>(OUTBOX);
  const correlationId = randomUUID();
  await app.get<UnitOfWorkPort>(UNIT_OF_WORK).withTransaction((ctx) =>
    writeStations(entityManagerOf(ctx), (payload) =>
      outbox.append(
        ctx,
        buildStationChanged({
          eventId: randomUUID(),
          correlationId,
          occurredAt: new Date(),
          payload,
        }),
      ),
    ),
  );
  await app.get(StationsService).invalidate();
}

export async function main(): Promise<void> {
  await withBackgroundJobsDisabled(async () => {
    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(CatalogModule);
      await seedStations(app);
      console.log(`Seeded ${governorates.length} governorates.`);
    } finally {
      await app?.close();
    }
  });
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  main().catch((error: unknown) => {
    console.error('Station seed failed:', error);
    process.exitCode = 1;
  });
}
