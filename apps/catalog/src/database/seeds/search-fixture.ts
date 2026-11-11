import type { TrainCoachCompositionSnapshotItem } from '../../modules/trips/entities/dated-trip.entity.js';

/**
 * A small but coherent network, with one trip per scenario the search specs
 * need.
 *
 * It writes `dated_trip` and `trip_stop` directly rather than going through
 * TA-16's generator, which does not exist yet. That is what lets TA-17 ship
 * without waiting, and `search-fixture.spec.ts` doubles as the contract the
 * generator has to satisfy later: dense 1-based positions, time advancing
 * along the route, a departure at every boardable stop.
 *
 * Every id is fixed, so a spec can assert on one. Instants are written as
 * Cairo local times with an explicit offset -- clearer than arithmetic, and it
 * keeps the daylight-saving trip honest about which side of the transition it
 * sits on.
 */

function fixtureUuid(group: number, item: number): string {
  return `0000${String(group).padStart(4, '0')}-0000-4000-8000-${String(
    item,
  ).padStart(12, '0')}`;
}

/** A Cairo wall-clock moment, with the offset in force spelled out. */
function cairoAt(date: string, time: string, offset: '+02:00' | '+03:00'): Date {
  return new Date(`${date}T${time}:00${offset}`);
}

/** June in Cairo is summer time. */
const SUMMER = '+03:00';

export const SEARCH_FIXTURE_IDS = {
  governorates: {
    alexandria: fixtureUuid(1, 1),
    gharbia: fixtureUuid(1, 2),
    qalyubia: fixtureUuid(1, 3),
    cairo: fixtureUuid(1, 4),
    giza: fixtureUuid(1, 5),
    assiut: fixtureUuid(1, 6),
    aswan: fixtureUuid(1, 7),
  },
  cities: {
    alexandria: fixtureUuid(2, 1),
    tanta: fixtureUuid(2, 2),
    banha: fixtureUuid(2, 3),
    cairo: fixtureUuid(2, 4),
    giza: fixtureUuid(2, 5),
    assiut: fixtureUuid(2, 6),
    aswan: fixtureUuid(2, 7),
  },
  stations: {
    alexandria: fixtureUuid(3, 1),
    tanta: fixtureUuid(3, 2),
    banha: fixtureUuid(3, 3),
    ramsis: fixtureUuid(3, 4),
    giza: fixtureUuid(3, 5),
    assiut: fixtureUuid(3, 6),
    aswan: fixtureUuid(3, 7),
    /** Exists but closed: a search naming it is refused, not answered empty. */
    inactive: fixtureUuid(3, 8),
  },
  trainTypes: {
    express: fixtureUuid(4, 1),
    sleeper: fixtureUuid(4, 2),
  },
  travelClasses: {
    first: fixtureUuid(5, 1),
    second: fixtureUuid(5, 2),
  },
  coachLayouts: {
    first: fixtureUuid(6, 1),
    second: fixtureUuid(6, 2),
  },
  trains: {
    mainLine: fixtureUuid(7, 1),
    overnight: fixtureUuid(7, 2),
    singleClass: fixtureUuid(7, 3),
    loop: fixtureUuid(7, 4),
  },
  timetables: {
    mainLine: fixtureUuid(9, 1),
    overnight: fixtureUuid(9, 2),
    singleClass: fixtureUuid(9, 3),
    loop: fixtureUuid(9, 4),
  },
  trips: {
    mainLine: fixtureUuid(11, 1),
    overnight: fixtureUuid(11, 2),
    singleClass: fixtureUuid(11, 3),
    loop: fixtureUuid(11, 4),
    springForward: fixtureUuid(11, 5),
    draft: fixtureUuid(11, 6),
    withdrawn: fixtureUuid(11, 7),
  },
} as const;

const IDS = SEARCH_FIXTURE_IDS;

/** Train numbers, which travellers type and the optional filter matches. */
export const SEARCH_FIXTURE_TRAIN_NUMBERS = {
  mainLine: 903,
  overnight: 980,
  singleClass: 404,
  loop: 606,
} as const;

export interface FixtureGovernorate {
  id: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
}

export interface FixtureCity {
  id: string;
  governorateId: string;
  nameAr: string;
  nameEn: string;
}

export interface FixtureStation {
  id: string;
  cityId: string;
  nameAr: string;
  nameEn: string;
  altSpellings: string[];
  isActive: boolean;
}

export interface FixtureNamed {
  id: string;
  nameAr: string;
  nameEn: string;
}

export interface FixtureCoachLayout {
  id: string;
  layoutName: string;
  rows: { rowNumber: number; leftSeats: string[]; rightSeats: string[] }[];
}

export interface FixtureTrain {
  id: string;
  trainNumber: number;
  trainTypeId: string;
}

export interface FixtureTrainCoach {
  id: string;
  trainId: string;
  position: number;
  coachNumber: number;
  travelClassId: string;
  coachLayoutId: string;
}

export interface FixtureTimetable {
  id: string;
  trainId: string;
  runningDays: number[];
  effectiveFrom: string;
  effectiveUntil: string | null;
  version: number;
  status: 'draft' | 'published' | 'withdrawn';
}

export interface FixtureTimetableStop {
  id: string;
  timetableId: string;
  stationId: string;
  position: number;
  dayOffset: number;
  arrivalTime: string | null;
  departureTime: string | null;
}

export interface FixtureDatedTrip {
  id: string;
  trainId: string;
  timetableId: string;
  serviceDate: string;
  timetableVersion: number;
  compositionSnapshot: TrainCoachCompositionSnapshotItem[];
  status: 'draft' | 'published' | 'withdrawn';
  publishedAt: Date | null;
}

export interface FixtureTripStop {
  id: string;
  tripId: string;
  stationId: string;
  position: number;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

export interface FixtureFare {
  id: string;
  trainId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  effectiveFrom: Date;
}

function seatRows(count: number, perSide: number) {
  return Array.from({ length: count }, (_, index) => ({
    rowNumber: index + 1,
    leftSeats: Array.from({ length: perSide }, (_, seat) => `L${index + 1}-${seat + 1}`),
    rightSeats: Array.from({ length: perSide }, (_, seat) => `R${index + 1}-${seat + 1}`),
  }));
}

/** 10 rows of 2+2 = 40 seats. */
const FIRST_LAYOUT: FixtureCoachLayout = {
  id: IDS.coachLayouts.first,
  layoutName: 'first-2-2-10',
  rows: seatRows(10, 2),
};

/** 12 rows of 3+3 = 72 seats. */
const SECOND_LAYOUT: FixtureCoachLayout = {
  id: IDS.coachLayouts.second,
  layoutName: 'second-3-3-12',
  rows: seatRows(12, 3),
};

function coachSnapshot(
  position: number,
  coachNumber: number,
  travelClass: { id: string; nameEn: string; nameAr: string },
  layout: FixtureCoachLayout,
): TrainCoachCompositionSnapshotItem {
  return {
    position,
    coachNumber,
    travelClass,
    coachLayout: {
      id: layout.id,
      layoutName: layout.layoutName,
      rows: layout.rows,
    },
  };
}

const FIRST_CLASS = {
  id: IDS.travelClasses.first,
  nameEn: 'First Class',
  nameAr: 'الدرجة الأولى',
};

const SECOND_CLASS = {
  id: IDS.travelClasses.second,
  nameEn: 'Second Class',
  nameAr: 'الدرجة الثانية',
};

const BOTH_CLASSES = [
  coachSnapshot(1, 1, FIRST_CLASS, FIRST_LAYOUT),
  coachSnapshot(2, 2, SECOND_CLASS, SECOND_LAYOUT),
];

/** Seats in a travel class on a trip, summed from the snapshot's layouts. */
export function seatCapacityOf(
  trip: Pick<FixtureDatedTrip, 'compositionSnapshot'>,
  travelClassId: string,
): number {
  return trip.compositionSnapshot
    .filter((coach) => coach.travelClass.id === travelClassId)
    .reduce(
      (total, coach) =>
        total +
        coach.coachLayout.rows.reduce(
          (rowTotal, row) =>
            rowTotal + row.leftSeats.length + row.rightSeats.length,
          0,
        ),
      0,
    );
}

/**
 * The seven-stop southbound route, on a given date.
 *
 * Alexandria -> Tanta -> Banha -> Ramsis -> Giza -> Assiut -> Aswan, so a
 * search for any two of them in that order matches (BR-15) and the reverse
 * matches nothing. Alexandria to Ramsis has exactly two stops between.
 */
function mainLineStops(
  tripId: string,
  date: string,
  offset: '+02:00' | '+03:00',
  idBase: number,
): FixtureTripStop[] {
  const schedule: [string, string | null, string | null][] = [
    [IDS.stations.alexandria, null, '06:00'],
    [IDS.stations.tanta, '07:00', '07:05'],
    [IDS.stations.banha, '07:45', '07:50'],
    [IDS.stations.ramsis, '08:40', '08:50'],
    [IDS.stations.giza, '09:10', '09:15'],
    [IDS.stations.assiut, '13:30', '13:40'],
    [IDS.stations.aswan, '18:00', null],
  ];

  return schedule.map(([stationId, arrival, departure], index) => ({
    id: fixtureUuid(12, idBase + index),
    tripId,
    stationId,
    position: index + 1,
    arrivalAt: arrival === null ? null : cairoAt(date, arrival, offset),
    departureAt: departure === null ? null : cairoAt(date, departure, offset),
  }));
}

function mainLineTimetableStops(): FixtureTimetableStop[] {
  const schedule: [string, string | null, string | null][] = [
    [IDS.stations.alexandria, null, '06:00'],
    [IDS.stations.tanta, '07:00', '07:05'],
    [IDS.stations.banha, '07:45', '07:50'],
    [IDS.stations.ramsis, '08:40', '08:50'],
    [IDS.stations.giza, '09:10', '09:15'],
    [IDS.stations.assiut, '13:30', '13:40'],
    [IDS.stations.aswan, '18:00', null],
  ];

  return schedule.map(([stationId, arrivalTime, departureTime], index) => ({
    id: fixtureUuid(10, 1 + index),
    timetableId: IDS.timetables.mainLine,
    stationId,
    position: index + 1,
    dayOffset: 0,
    arrivalTime,
    departureTime,
  }));
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const SEARCH_FIXTURE = {
  // `governorate.sort_order` is UNIQUE, so these start at 101 to leave room for
  // the domain seed's own governorates. Both networks can then share one
  // database, which is what the seeder loads.
  governorates: [
    { id: IDS.governorates.alexandria, nameAr: 'الإسكندرية', nameEn: 'Alexandria', sortOrder: 101 },
    { id: IDS.governorates.gharbia, nameAr: 'الغربية', nameEn: 'Gharbia', sortOrder: 102 },
    { id: IDS.governorates.qalyubia, nameAr: 'القليوبية', nameEn: 'Qalyubia', sortOrder: 103 },
    { id: IDS.governorates.cairo, nameAr: 'القاهرة', nameEn: 'Cairo', sortOrder: 104 },
    { id: IDS.governorates.giza, nameAr: 'الجيزة', nameEn: 'Giza', sortOrder: 105 },
    { id: IDS.governorates.assiut, nameAr: 'أسيوط', nameEn: 'Assiut', sortOrder: 106 },
    { id: IDS.governorates.aswan, nameAr: 'أسوان', nameEn: 'Aswan', sortOrder: 107 },
  ] satisfies FixtureGovernorate[],

  cities: [
    { id: IDS.cities.alexandria, governorateId: IDS.governorates.alexandria, nameAr: 'الإسكندرية', nameEn: 'Alexandria' },
    { id: IDS.cities.tanta, governorateId: IDS.governorates.gharbia, nameAr: 'طنطا', nameEn: 'Tanta' },
    { id: IDS.cities.banha, governorateId: IDS.governorates.qalyubia, nameAr: 'بنها', nameEn: 'Banha' },
    { id: IDS.cities.cairo, governorateId: IDS.governorates.cairo, nameAr: 'القاهرة', nameEn: 'Cairo' },
    { id: IDS.cities.giza, governorateId: IDS.governorates.giza, nameAr: 'الجيزة', nameEn: 'Giza' },
    { id: IDS.cities.assiut, governorateId: IDS.governorates.assiut, nameAr: 'أسيوط', nameEn: 'Assiut' },
    { id: IDS.cities.aswan, governorateId: IDS.governorates.aswan, nameAr: 'أسوان', nameEn: 'Aswan' },
  ] satisfies FixtureCity[],

  stations: [
    { id: IDS.stations.alexandria, cityId: IDS.cities.alexandria, nameAr: 'محطة مصر', nameEn: 'Misr Station', altSpellings: ['Masr Station'], isActive: true },
    { id: IDS.stations.tanta, cityId: IDS.cities.tanta, nameAr: 'طنطا', nameEn: 'Tanta', altSpellings: [], isActive: true },
    { id: IDS.stations.banha, cityId: IDS.cities.banha, nameAr: 'بنها', nameEn: 'Banha', altSpellings: ['Benha'], isActive: true },
    { id: IDS.stations.ramsis, cityId: IDS.cities.cairo, nameAr: 'رمسيس', nameEn: 'Ramsis', altSpellings: ['Ramses'], isActive: true },
    { id: IDS.stations.giza, cityId: IDS.cities.giza, nameAr: 'الجيزة', nameEn: 'Giza', altSpellings: [], isActive: true },
    { id: IDS.stations.assiut, cityId: IDS.cities.assiut, nameAr: 'أسيوط', nameEn: 'Assiut', altSpellings: ['Asyut'], isActive: true },
    { id: IDS.stations.aswan, cityId: IDS.cities.aswan, nameAr: 'أسوان', nameEn: 'Aswan', altSpellings: [], isActive: true },
    { id: IDS.stations.inactive, cityId: IDS.cities.aswan, nameAr: 'كوم أمبو', nameEn: 'Kom Ombo', altSpellings: [], isActive: false },
  ] satisfies FixtureStation[],

  trainTypes: [
    { id: IDS.trainTypes.express, nameAr: 'مميز', nameEn: 'Express' },
    { id: IDS.trainTypes.sleeper, nameAr: 'نوم', nameEn: 'Sleeper' },
  ] satisfies FixtureNamed[],

  travelClasses: [
    { id: IDS.travelClasses.first, nameAr: FIRST_CLASS.nameAr, nameEn: FIRST_CLASS.nameEn },
    { id: IDS.travelClasses.second, nameAr: SECOND_CLASS.nameAr, nameEn: SECOND_CLASS.nameEn },
  ] satisfies FixtureNamed[],

  coachLayouts: [FIRST_LAYOUT, SECOND_LAYOUT] satisfies FixtureCoachLayout[],

  trains: [
    { id: IDS.trains.mainLine, trainNumber: SEARCH_FIXTURE_TRAIN_NUMBERS.mainLine, trainTypeId: IDS.trainTypes.express },
    { id: IDS.trains.overnight, trainNumber: SEARCH_FIXTURE_TRAIN_NUMBERS.overnight, trainTypeId: IDS.trainTypes.sleeper },
    { id: IDS.trains.singleClass, trainNumber: SEARCH_FIXTURE_TRAIN_NUMBERS.singleClass, trainTypeId: IDS.trainTypes.express },
    { id: IDS.trains.loop, trainNumber: SEARCH_FIXTURE_TRAIN_NUMBERS.loop, trainTypeId: IDS.trainTypes.express },
  ] satisfies FixtureTrain[],

  trainCoaches: [
    { id: fixtureUuid(8, 1), trainId: IDS.trains.mainLine, position: 1, coachNumber: 1, travelClassId: IDS.travelClasses.first, coachLayoutId: IDS.coachLayouts.first },
    { id: fixtureUuid(8, 2), trainId: IDS.trains.mainLine, position: 2, coachNumber: 2, travelClassId: IDS.travelClasses.second, coachLayoutId: IDS.coachLayouts.second },
    { id: fixtureUuid(8, 3), trainId: IDS.trains.overnight, position: 1, coachNumber: 1, travelClassId: IDS.travelClasses.first, coachLayoutId: IDS.coachLayouts.first },
    // No first-class coach at all, so a first-class search must not list it.
    { id: fixtureUuid(8, 4), trainId: IDS.trains.singleClass, position: 1, coachNumber: 1, travelClassId: IDS.travelClasses.second, coachLayoutId: IDS.coachLayouts.second },
    { id: fixtureUuid(8, 5), trainId: IDS.trains.loop, position: 1, coachNumber: 1, travelClassId: IDS.travelClasses.first, coachLayoutId: IDS.coachLayouts.first },
  ] satisfies FixtureTrainCoach[],

  timetables: [
    { id: IDS.timetables.mainLine, trainId: IDS.trains.mainLine, runningDays: EVERY_DAY, effectiveFrom: '2026-01-01', effectiveUntil: null, version: 1, status: 'published' },
    { id: IDS.timetables.overnight, trainId: IDS.trains.overnight, runningDays: EVERY_DAY, effectiveFrom: '2026-01-01', effectiveUntil: null, version: 1, status: 'published' },
    { id: IDS.timetables.singleClass, trainId: IDS.trains.singleClass, runningDays: EVERY_DAY, effectiveFrom: '2026-01-01', effectiveUntil: null, version: 1, status: 'published' },
    { id: IDS.timetables.loop, trainId: IDS.trains.loop, runningDays: EVERY_DAY, effectiveFrom: '2026-01-01', effectiveUntil: null, version: 1, status: 'published' },
  ] satisfies FixtureTimetable[],

  // The empty-reason probes ask the timetables, not the dated trips, so these
  // rows decide whether "no train runs between these stations" is the answer.
  timetableStops: [
    ...mainLineTimetableStops(),
    { id: fixtureUuid(10, 21), timetableId: IDS.timetables.overnight, stationId: IDS.stations.ramsis, position: 1, dayOffset: 0, arrivalTime: null, departureTime: '23:00' },
    { id: fixtureUuid(10, 22), timetableId: IDS.timetables.overnight, stationId: IDS.stations.assiut, position: 2, dayOffset: 1, arrivalTime: '04:00', departureTime: '04:10' },
    { id: fixtureUuid(10, 23), timetableId: IDS.timetables.overnight, stationId: IDS.stations.aswan, position: 3, dayOffset: 1, arrivalTime: '09:20', departureTime: null },
    { id: fixtureUuid(10, 31), timetableId: IDS.timetables.singleClass, stationId: IDS.stations.tanta, position: 1, dayOffset: 0, arrivalTime: null, departureTime: '10:00' },
    { id: fixtureUuid(10, 32), timetableId: IDS.timetables.singleClass, stationId: IDS.stations.banha, position: 2, dayOffset: 0, arrivalTime: '10:40', departureTime: null },
    { id: fixtureUuid(10, 41), timetableId: IDS.timetables.loop, stationId: IDS.stations.ramsis, position: 1, dayOffset: 0, arrivalTime: null, departureTime: '07:00' },
    { id: fixtureUuid(10, 42), timetableId: IDS.timetables.loop, stationId: IDS.stations.banha, position: 2, dayOffset: 0, arrivalTime: '07:50', departureTime: '08:00' },
    { id: fixtureUuid(10, 43), timetableId: IDS.timetables.loop, stationId: IDS.stations.tanta, position: 3, dayOffset: 0, arrivalTime: '08:40', departureTime: '08:50' },
    { id: fixtureUuid(10, 44), timetableId: IDS.timetables.loop, stationId: IDS.stations.banha, position: 4, dayOffset: 0, arrivalTime: '09:30', departureTime: '09:40' },
    { id: fixtureUuid(10, 45), timetableId: IDS.timetables.loop, stationId: IDS.stations.ramsis, position: 5, dayOffset: 0, arrivalTime: '10:30', departureTime: null },
  ] satisfies FixtureTimetableStop[],

  datedTrips: [
    { id: IDS.trips.mainLine, trainId: IDS.trains.mainLine, timetableId: IDS.timetables.mainLine, serviceDate: '2026-06-20', timetableVersion: 1, compositionSnapshot: BOTH_CLASSES, status: 'published', publishedAt: cairoAt('2026-06-01', '09:00', SUMMER) },
    // Leaves its first station at 23:00 on the 19th and departs Assiut at
    // 04:10 on the 20th, so Assiut onwards belongs to the 20th (BR-16).
    { id: IDS.trips.overnight, trainId: IDS.trains.overnight, timetableId: IDS.timetables.overnight, serviceDate: '2026-06-19', timetableVersion: 1, compositionSnapshot: [coachSnapshot(1, 1, FIRST_CLASS, FIRST_LAYOUT)], status: 'published', publishedAt: cairoAt('2026-06-01', '09:00', SUMMER) },
    { id: IDS.trips.singleClass, trainId: IDS.trains.singleClass, timetableId: IDS.timetables.singleClass, serviceDate: '2026-06-20', timetableVersion: 1, compositionSnapshot: [coachSnapshot(1, 1, SECOND_CLASS, SECOND_LAYOUT)], status: 'published', publishedAt: cairoAt('2026-06-01', '09:00', SUMMER) },
    { id: IDS.trips.loop, trainId: IDS.trains.loop, timetableId: IDS.timetables.loop, serviceDate: '2026-06-20', timetableVersion: 1, compositionSnapshot: [coachSnapshot(1, 1, FIRST_CLASS, FIRST_LAYOUT)], status: 'published', publishedAt: cairoAt('2026-06-01', '09:00', SUMMER) },
    // Cairo's clocks jump from 00:00 to 01:00 on this date, so every time on
    // it is already +03:00 and the day is 23 hours long.
    { id: IDS.trips.springForward, trainId: IDS.trains.mainLine, timetableId: IDS.timetables.mainLine, serviceDate: '2026-04-24', timetableVersion: 1, compositionSnapshot: BOTH_CLASSES, status: 'published', publishedAt: cairoAt('2026-04-01', '09:00', '+02:00') },
    { id: IDS.trips.draft, trainId: IDS.trains.mainLine, timetableId: IDS.timetables.mainLine, serviceDate: '2026-06-21', timetableVersion: 1, compositionSnapshot: BOTH_CLASSES, status: 'draft', publishedAt: null },
    { id: IDS.trips.withdrawn, trainId: IDS.trains.mainLine, timetableId: IDS.timetables.mainLine, serviceDate: '2026-06-22', timetableVersion: 1, compositionSnapshot: BOTH_CLASSES, status: 'withdrawn', publishedAt: cairoAt('2026-06-01', '09:00', SUMMER) },
  ] satisfies FixtureDatedTrip[],

  tripStops: [
    ...mainLineStops(IDS.trips.mainLine, '2026-06-20', SUMMER, 100),
    { id: fixtureUuid(12, 201), tripId: IDS.trips.overnight, stationId: IDS.stations.ramsis, position: 1, arrivalAt: null, departureAt: cairoAt('2026-06-19', '23:00', SUMMER) },
    { id: fixtureUuid(12, 202), tripId: IDS.trips.overnight, stationId: IDS.stations.assiut, position: 2, arrivalAt: cairoAt('2026-06-20', '04:00', SUMMER), departureAt: cairoAt('2026-06-20', '04:10', SUMMER) },
    { id: fixtureUuid(12, 203), tripId: IDS.trips.overnight, stationId: IDS.stations.aswan, position: 3, arrivalAt: cairoAt('2026-06-20', '09:20', SUMMER), departureAt: null },
    { id: fixtureUuid(12, 301), tripId: IDS.trips.singleClass, stationId: IDS.stations.tanta, position: 1, arrivalAt: null, departureAt: cairoAt('2026-06-20', '10:00', SUMMER) },
    { id: fixtureUuid(12, 302), tripId: IDS.trips.singleClass, stationId: IDS.stations.banha, position: 2, arrivalAt: cairoAt('2026-06-20', '10:40', SUMMER), departureAt: null },
    // Calls at Banha twice, so Ramsis -> Banha has two valid pairings and the
    // query must still return one row.
    { id: fixtureUuid(12, 401), tripId: IDS.trips.loop, stationId: IDS.stations.ramsis, position: 1, arrivalAt: null, departureAt: cairoAt('2026-06-20', '07:00', SUMMER) },
    { id: fixtureUuid(12, 402), tripId: IDS.trips.loop, stationId: IDS.stations.banha, position: 2, arrivalAt: cairoAt('2026-06-20', '07:50', SUMMER), departureAt: cairoAt('2026-06-20', '08:00', SUMMER) },
    { id: fixtureUuid(12, 403), tripId: IDS.trips.loop, stationId: IDS.stations.tanta, position: 3, arrivalAt: cairoAt('2026-06-20', '08:40', SUMMER), departureAt: cairoAt('2026-06-20', '08:50', SUMMER) },
    { id: fixtureUuid(12, 404), tripId: IDS.trips.loop, stationId: IDS.stations.banha, position: 4, arrivalAt: cairoAt('2026-06-20', '09:30', SUMMER), departureAt: cairoAt('2026-06-20', '09:40', SUMMER) },
    { id: fixtureUuid(12, 405), tripId: IDS.trips.loop, stationId: IDS.stations.ramsis, position: 5, arrivalAt: cairoAt('2026-06-20', '10:30', SUMMER), departureAt: null },
    ...mainLineStops(IDS.trips.springForward, '2026-04-24', SUMMER, 500),
    ...mainLineStops(IDS.trips.draft, '2026-06-21', SUMMER, 600),
    ...mainLineStops(IDS.trips.withdrawn, '2026-06-22', SUMMER, 700),
  ] satisfies FixtureTripStop[],

  fares: [
    // Three versions of one price: an old one, the one in force, and one that
    // has not started yet. The query must pick the middle.
    { id: fixtureUuid(13, 1), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.alexandria, destinationStationId: IDS.stations.ramsis, amountPiastres: 14000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 2), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.alexandria, destinationStationId: IDS.stations.ramsis, amountPiastres: 15500, effectiveFrom: new Date('2026-06-01T00:00:00Z') },
    { id: fixtureUuid(13, 3), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.alexandria, destinationStationId: IDS.stations.ramsis, amountPiastres: 20000, effectiveFrom: new Date('2026-12-01T00:00:00Z') },
    { id: fixtureUuid(13, 4), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.second, originStationId: IDS.stations.alexandria, destinationStationId: IDS.stations.ramsis, amountPiastres: 9000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 5), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.tanta, destinationStationId: IDS.stations.giza, amountPiastres: 7000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 6), trainId: IDS.trains.mainLine, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.alexandria, destinationStationId: IDS.stations.aswan, amountPiastres: 42000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 7), trainId: IDS.trains.overnight, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.ramsis, destinationStationId: IDS.stations.assiut, amountPiastres: 18000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 8), trainId: IDS.trains.overnight, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.assiut, destinationStationId: IDS.stations.aswan, amountPiastres: 12000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    { id: fixtureUuid(13, 9), trainId: IDS.trains.loop, travelClassId: IDS.travelClasses.first, originStationId: IDS.stations.ramsis, destinationStationId: IDS.stations.banha, amountPiastres: 3000, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    // Train 404 has no fare at all: an unpriceable trip cannot be booked, so
    // search must exclude it rather than show a blank price.
  ] satisfies FixtureFare[],
} as const;
