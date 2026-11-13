import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';

import { CatalogModule } from '../../catalog.module.js';

import { StationsService } from '../../modules/stations/stations.service.js';
import { buildStationChanged } from '../../modules/stations/station-events.factory.js';
import { CATALOG_STATION_IDS } from './stations.js';
import { writeStations } from './stations.seed.js';

import { TrainTypeEntity } from '../../modules/trains/entities/train-type.entity.js';
import { TravelClassEntity } from '../../modules/trains/entities/travel-class.entity.js';
import {
  CoachLayoutEntity,
  type CoachLayoutRow,
} from '../../modules/trains/entities/coach-layout.entity.js';
import { withBackgroundJobsDisabled } from '../../config/trip-generation-settings.js';
import { TrainEntity } from '../../modules/trains/entities/train.entity.js';
import { TrainCoachEntity } from '../../modules/trains/entities/train-coach.entity.js';

import { TimetableEntity } from '../../modules/timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../../modules/timetables/entities/timetable-stop.entity.js';

import { FareEntity } from '../../modules/fares/entities/fare.entity.js';

import { TimetablesService } from '../../modules/timetables/timetables.service.js';

// Stable IDs make the seed safe to run more than once.
const IDS = {
  trainType: '00000000-0000-4000-8000-000000000101',

  classes: {
    first: '00000000-0000-4000-8000-000000000111',
    second: '00000000-0000-4000-8000-000000000112',
  },

  layouts: {
    first: '00000000-0000-4000-8000-000000000121',
    second: '00000000-0000-4000-8000-000000000122',
  },

  train: '00000000-0000-4000-8000-000000000131',

  coaches: {
    first: '00000000-0000-4000-8000-000000000141',
    second: '00000000-0000-4000-8000-000000000142',
  },

  timetable: '00000000-0000-4000-8000-000000000201',

  timetableStops: {
    cairo: '00000000-0000-4000-8000-000000000211',
    giza: '00000000-0000-4000-8000-000000000212',
    beniSuef: '00000000-0000-4000-8000-000000000213',
  },

  fares: {
    cairoGizaFirst: '00000000-0000-4000-8000-000000000301',
    cairoBeniSuefFirst: '00000000-0000-4000-8000-000000000302',
    gizaBeniSuefFirst: '00000000-0000-4000-8000-000000000303',
    cairoGizaSecond: '00000000-0000-4000-8000-000000000304',
    cairoBeniSuefSecond: '00000000-0000-4000-8000-000000000305',
    gizaBeniSuefSecond: '00000000-0000-4000-8000-000000000306',
  },
};

export async function seedCatalog(app: INestApplicationContext): Promise<void> {
  const outbox = app.get<OutboxPort>(OUTBOX);
  const correlationId = randomUUID();

  await app.get<UnitOfWorkPort>(UNIT_OF_WORK).withTransaction(async (ctx) => {
    const manager = entityManagerOf(ctx);
    // 1-3. Use the same governorates, cities and stations as the station-only CLI.
    await writeStations(manager, (payload) =>
      outbox.append(
        ctx,
        buildStationChanged({
          eventId: randomUUID(),
          correlationId,
          occurredAt: new Date(),
          payload,
        }),
      ),
    );

    // 4. Create train type and travel classes.
    await manager.getRepository(TrainTypeEntity).save({
      id: IDS.trainType,
      nameEn: 'Express',
      nameAr: 'إكسبريس',
    });

    await manager.getRepository(TravelClassEntity).save([
      {
        id: IDS.classes.first,
        nameEn: 'First Class',
        nameAr: 'الدرجة الأولى',
      },
      {
        id: IDS.classes.second,
        nameEn: 'Second Class',
        nameAr: 'الدرجة الثانية',
      },
    ]);

    // 5. Create coach layouts. Seats are per side of the aisle: that is what
    // makes two adjacent (D2, BR-25), and what the capacity SQL sums.
    const rows: CoachLayoutRow[] = [
      { rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3', '4'] },
      { rowNumber: 2, leftSeats: ['5', '6'], rightSeats: ['7', '8'] },
    ];

    await manager.getRepository(CoachLayoutEntity).save([
      {
        id: IDS.layouts.first,
        layoutName: 'Seed First Class Layout',
        rows,
      },
      {
        id: IDS.layouts.second,
        layoutName: 'Seed Second Class Layout',
        rows,
      },
    ]);

    // 6. Create a train.
    await manager.getRepository(TrainEntity).save({
      id: IDS.train,
      trainNumber: 9001,
      trainType: { id: IDS.trainType },
    });

    // 7. Add one coach for each travel class.
    await manager.getRepository(TrainCoachEntity).save([
      {
        id: IDS.coaches.first,
        train: { id: IDS.train },
        position: 1,
        coachNumber: 1,
        travelClass: { id: IDS.classes.first },
        coachLayout: { id: IDS.layouts.first },
      },
      {
        id: IDS.coaches.second,
        train: { id: IDS.train },
        position: 2,
        coachNumber: 2,
        travelClass: { id: IDS.classes.second },
        coachLayout: { id: IDS.layouts.second },
      },
    ]);

    // 8. Create the timetable only if it does not already exist.
    // This preserves its published status when the seed runs again.
    const timetableRepository = manager.getRepository(TimetableEntity);

    const existingTimetable = await timetableRepository.findOne({
      where: { id: IDS.timetable },
    });

    if (!existingTimetable) {
      await timetableRepository.save({
        id: IDS.timetable,
        train: { id: IDS.train },
        runningDays: [0, 1, 2, 3, 4, 5, 6] as TimetableEntity['runningDays'],
        effectiveFrom: '2020-01-01',
        effectiveUntil: null,
        version: 1,
        status: 'draft' as TimetableEntity['status'],
      });
    }

    // 9. Add the ordered timetable stops.
    await manager.getRepository(TimetableStopEntity).save([
      {
        id: IDS.timetableStops.cairo,
        timetable: { id: IDS.timetable },
        station: { id: CATALOG_STATION_IDS.cairo },
        stationId: CATALOG_STATION_IDS.cairo,
        position: 1,
        dayOffset: 0,
        arrivalTime: null,
        departureTime: '08:00',
      },
      {
        id: IDS.timetableStops.giza,
        timetable: { id: IDS.timetable },
        station: { id: CATALOG_STATION_IDS.giza },
        stationId: CATALOG_STATION_IDS.giza,
        position: 2,
        dayOffset: 0,
        arrivalTime: '08:40',
        departureTime: '08:45',
      },
      {
        id: IDS.timetableStops.beniSuef,
        timetable: { id: IDS.timetable },
        station: { id: CATALOG_STATION_IDS.beniSuef },
        stationId: CATALOG_STATION_IDS.beniSuef,
        position: 3,
        dayOffset: 0,
        arrivalTime: '10:30',
        departureTime: null,
      },
    ]);

    // 10. Add fare coverage for every station pair and travel class.
    const fareRepository = manager.getRepository(FareEntity);
    const effectiveFrom = new Date('2020-01-01T00:00:00.000Z');

    await fareRepository.save([
      {
        id: IDS.fares.cairoGizaFirst,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.first },
        originStationId: CATALOG_STATION_IDS.cairo,
        destinationStationId: CATALOG_STATION_IDS.giza,
        amountPiastres: 5000,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoBeniSuefFirst,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.first },
        originStationId: CATALOG_STATION_IDS.cairo,
        destinationStationId: CATALOG_STATION_IDS.beniSuef,
        amountPiastres: 15000,
        effectiveFrom,
      },
      {
        id: IDS.fares.gizaBeniSuefFirst,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.first },
        originStationId: CATALOG_STATION_IDS.giza,
        destinationStationId: CATALOG_STATION_IDS.beniSuef,
        amountPiastres: 10000,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoGizaSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: CATALOG_STATION_IDS.cairo,
        destinationStationId: CATALOG_STATION_IDS.giza,
        amountPiastres: 3500,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoBeniSuefSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: CATALOG_STATION_IDS.cairo,
        destinationStationId: CATALOG_STATION_IDS.beniSuef,
        amountPiastres: 10000,
        effectiveFrom,
      },
      {
        id: IDS.fares.gizaBeniSuefSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: CATALOG_STATION_IDS.giza,
        destinationStationId: CATALOG_STATION_IDS.beniSuef,
        amountPiastres: 7000,
        effectiveFrom,
      },
    ]);
  });

  await app.get(StationsService).invalidate();

  // Publish through the normal application flow.
  await app.get(TimetablesService).publishTimetable(IDS.timetable);
}

export async function main(): Promise<void> {
  await withBackgroundJobsDisabled(async () => {
    let app: INestApplicationContext | undefined;

    try {
      app = await NestFactory.createApplicationContext(CatalogModule);

      await seedCatalog(app);

      console.log('Catalog seed completed successfully.');
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
    console.error('Catalog seed failed:', error);
    process.exitCode = 1;
  });
}
