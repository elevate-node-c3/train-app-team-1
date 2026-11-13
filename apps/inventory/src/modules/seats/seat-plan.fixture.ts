import { randomUUID } from 'node:crypto';
import type { TripPublishedCoachV1, TripPublishedPayloadV1 } from '@app/contracts';

/**
 * Shared publication fixtures. Ids for trip, stations, coaches and travel
 * classes match test/integration/support/inventory-fixture.ts so Task 6's
 * integration assertions line up with this task's unit plan.
 */

const TRIP_ID = '10000000-0000-0000-0000-000000000001';

const STATION_IDS = [
  '20000000-0000-0000-0000-000000000000',
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000005',
];

const COACH_NUMBERS = [1, 2];

const TRAVEL_CLASS_IDS = [
  '50000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000002',
];

const TRAVEL_CLASS_NAMES: Array<{ nameEn: string; nameAr: string }> = [
  { nameEn: 'Economy', nameAr: 'اقتصادية' },
  { nameEn: 'Business', nameAr: 'درجة أولى' },
];

type Row = { rowNumber: number; leftSeats: string[]; rightSeats: string[] };

/** Five rows, seats 1-10, odd seats left and even seats right — matches the Task 3 seed. */
function tenSeatRows(): Row[] {
  const rows: Row[] = [];
  for (let r = 1; r <= 5; r += 1) {
    rows.push({ rowNumber: r, leftSeats: [String(2 * r - 1)], rightSeats: [String(2 * r)] });
  }
  return rows;
}

function coachOf(index: number, rows: Row[]): TripPublishedCoachV1 {
  return {
    position: index,
    coachNumber: COACH_NUMBERS[index],
    travelClass: {
      id: TRAVEL_CLASS_IDS[index],
      nameEn: TRAVEL_CLASS_NAMES[index].nameEn,
      nameAr: TRAVEL_CLASS_NAMES[index].nameAr,
    },
    coachLayout: {
      id: randomUUID(),
      layoutName: `layout-${index + 1}`,
      rows,
    },
  };
}

/** Cairo -> Alexandria, six stops, two coaches of ten seats each (20 seats total). */
export function sixStopPayload(): TripPublishedPayloadV1 {
  return {
    tripId: TRIP_ID,
    trainId: randomUUID(),
    trainNumber: 123,
    trainType: { id: randomUUID(), nameEn: 'Express', nameAr: 'سريع' },
    serviceDate: '2026-11-20',
    timetableVersion: 1,
    capacity: 20,
    stops: STATION_IDS.map((stationId, index) => ({
      stationId,
      position: index * 10,
      arrivalAt: index === 0 ? null : `2026-11-20T${String(8 + index).padStart(2, '0')}:00:00+02:00`,
      departureAt:
        index === STATION_IDS.length - 1
          ? null
          : `2026-11-20T${String(8 + index).padStart(2, '0')}:05:00+02:00`,
    })),
    coaches: [coachOf(0, tenSeatRows()), coachOf(1, tenSeatRows())],
  };
}

/** A payload whose stops carry catalog's own (possibly out-of-order) positions. */
export function payloadWithStopPositions(positions: number[]): TripPublishedPayloadV1 {
  const base = sixStopPayload();
  return {
    ...base,
    stops: positions.map((position) => ({
      stationId: randomUUID(),
      position,
      arrivalAt: null,
      departureAt: null,
    })),
  };
}

/** A payload with exactly two stops. */
export function twoStopPayload(): TripPublishedPayloadV1 {
  const base = sixStopPayload();
  return { ...base, stops: base.stops.slice(0, 2) };
}

/** A single-coach payload with the given layout rows. */
export function payloadWithRows(rows: Row[]): TripPublishedPayloadV1 {
  const base = sixStopPayload();
  return { ...base, coaches: [coachOf(0, rows)] };
}

/** A single-coach, single-row payload holding exactly the given seat numbers on its left side. */
export function payloadWithRow(row: Row): TripPublishedPayloadV1 {
  return payloadWithRows([row]);
}

export function payloadWithSeats(seatNumbers: string[]): TripPublishedPayloadV1 {
  return payloadWithRows([{ rowNumber: 1, leftSeats: seatNumbers, rightSeats: [] }]);
}

/** Two full coaches sharing one coach number — a malformed duplicate. */
export function withTwoCoachesNumbered(coachNumber: number): TripPublishedPayloadV1 {
  const base = sixStopPayload();
  const coaches = base.coaches.map((coach) => ({ ...coach, coachNumber }));
  return { ...base, coaches };
}
