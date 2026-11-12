import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { CatalogModule } from '../../catalog.module.js';

import { GovernorateEntity } from '../../modules/stations/entities/governorate.entity.js';
import { CityEntity } from '../../modules/stations/entities/city.entity.js';
import { StationEntity } from '../../modules/stations/entities/station.entity.js';

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
  governorates: {
    cairo: '00000000-0000-4000-8000-000000000001',
    giza: '00000000-0000-4000-8000-000000000002',
    beniSuef: '00000000-0000-4000-8000-000000000003',
  },

  cities: {
    cairo: '00000000-0000-4000-8000-000000000011',
    giza: '00000000-0000-4000-8000-000000000012',
    beniSuef: '00000000-0000-4000-8000-000000000013',
  },

  stations: {
    cairo: '00000000-0000-4000-8000-000000000021',
    giza: '00000000-0000-4000-8000-000000000022',
    beniSuef: '00000000-0000-4000-8000-000000000023',
  },

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

async function seedCatalog(app: INestApplicationContext): Promise<void> {
  const dataSource = app.get(DataSource);

  await dataSource.transaction(async (manager) => {
    // 1. Create governorates.
    await manager.getRepository(GovernorateEntity).save([
      {
        id: IDS.governorates.cairo,
        nameAr: 'القاهرة',
        nameEn: 'Cairo',
        sortOrder: 1,
      },
      {
        id: IDS.governorates.giza,
        nameAr: 'الجيزة',
        nameEn: 'Giza',
        sortOrder: 2,
      },
      {
        id: IDS.governorates.beniSuef,
        nameAr: 'بني سويف',
        nameEn: 'Beni Suef',
        sortOrder: 3,
      },
    ]);

    // 2. Create cities.
    await manager.getRepository(CityEntity).save([
      {
        id: IDS.cities.cairo,
        governorateId: IDS.governorates.cairo,
        nameAr: 'القاهرة',
        nameEn: 'Cairo',
      },
      {
        id: IDS.cities.giza,
        governorateId: IDS.governorates.giza,
        nameAr: 'الجيزة',
        nameEn: 'Giza',
      },
      {
        id: IDS.cities.beniSuef,
        governorateId: IDS.governorates.beniSuef,
        nameAr: 'بني سويف',
        nameEn: 'Beni Suef',
      },
    ]);

    // 3. Create stations.
    await manager.getRepository(StationEntity).save([
      {
        id: IDS.stations.cairo,
        cityId: IDS.cities.cairo,
        nameAr: 'محطة رمسيس',
        nameEn: 'Cairo Ramses',
        altSpellings: ['Ramses', 'Ramses Station'],
        isActive: true,
      },
      {
        id: IDS.stations.giza,
        cityId: IDS.cities.giza,
        nameAr: 'محطة الجيزة',
        nameEn: 'Giza Station',
        altSpellings: ['Giza'],
        isActive: true,
      },
      {
        id: IDS.stations.beniSuef,
        cityId: IDS.cities.beniSuef,
        nameAr: 'محطة بني سويف',
        nameEn: 'Beni Suef Station',
        altSpellings: ['Beni Suef'],
        isActive: true,
      },
    ]);

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
        station: { id: IDS.stations.cairo },
        stationId: IDS.stations.cairo,
        position: 1,
        dayOffset: 0,
        arrivalTime: null,
        departureTime: '08:00',
      },
      {
        id: IDS.timetableStops.giza,
        timetable: { id: IDS.timetable },
        station: { id: IDS.stations.giza },
        stationId: IDS.stations.giza,
        position: 2,
        dayOffset: 0,
        arrivalTime: '08:40',
        departureTime: '08:45',
      },
      {
        id: IDS.timetableStops.beniSuef,
        timetable: { id: IDS.timetable },
        station: { id: IDS.stations.beniSuef },
        stationId: IDS.stations.beniSuef,
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
        originStationId: IDS.stations.cairo,
        destinationStationId: IDS.stations.giza,
        amountPiastres: 5000,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoBeniSuefFirst,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.first },
        originStationId: IDS.stations.cairo,
        destinationStationId: IDS.stations.beniSuef,
        amountPiastres: 15000,
        effectiveFrom,
      },
      {
        id: IDS.fares.gizaBeniSuefFirst,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.first },
        originStationId: IDS.stations.giza,
        destinationStationId: IDS.stations.beniSuef,
        amountPiastres: 10000,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoGizaSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: IDS.stations.cairo,
        destinationStationId: IDS.stations.giza,
        amountPiastres: 3500,
        effectiveFrom,
      },
      {
        id: IDS.fares.cairoBeniSuefSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: IDS.stations.cairo,
        destinationStationId: IDS.stations.beniSuef,
        amountPiastres: 10000,
        effectiveFrom,
      },
      {
        id: IDS.fares.gizaBeniSuefSecond,
        train: { id: IDS.train },
        travelClass: { id: IDS.classes.second },
        originStationId: IDS.stations.giza,
        destinationStationId: IDS.stations.beniSuef,
        amountPiastres: 7000,
        effectiveFrom,
      },
    ]);
  });

  // Publish through the normal application flow.
  await app.get(TimetablesService).publishTimetable(IDS.timetable);
}

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error('Catalog seed failed:', error);
  process.exitCode = 1;
});