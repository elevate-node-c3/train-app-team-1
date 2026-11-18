import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import {
  AllocationOutcome,
  HOLD_HELD_EVENT_TYPE,
  type CreateHoldRequest,
  type EventEnvelope,
  type HoldLifecyclePayloadV1,
  type HoldSnapshot,
  type ResolveHoldPassengersRequest,
  type ResolveHoldPassengersResponse,
} from '@app/contracts';
import type { CreateBookingDraftDto } from '../dto/create-booking-draft.dto.js';
import { BookingDraftEntity } from '../entities/booking-draft.entity.js';
import { BookingDraftStore } from '../booking-draft.store.js';

export const OWNER_ID = '10000000-0000-4000-8000-000000000001';
export const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000002';
export const PASSENGER_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
];
export const TRIP_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
];
export const CLASS_ID = '40000000-0000-4000-8000-000000000001';
export const ORIGIN_ID = '50000000-0000-4000-8000-000000000001';
export const DESTINATION_ID = '50000000-0000-4000-8000-000000000002';
export const HOLD_ID = '60000000-0000-4000-8000-000000000001';
export const SERVER_NOW = '2026-11-15T17:00:00.000Z';
export const EXPIRES_AT = '2026-11-15T17:08:00.000Z';

type DraftInputFixture = {
  [Key in keyof CreateBookingDraftDto]: CreateBookingDraftDto[Key];
};

export function draftInput(legs = 1, count = 2): DraftInputFixture {
  return {
    bookingKey: randomUUID(),
    userId: OWNER_ID,
    passengerIds: PASSENGER_IDS.slice(0, count),
    legs: TRIP_IDS.slice(0, legs).map((tripId, index) => ({
      tripId,
      travelClassId: CLASS_ID,
      originStationId: index === 0 ? ORIGIN_ID : DESTINATION_ID,
      destinationStationId: index === 0 ? DESTINATION_ID : ORIGIN_ID,
    })),
  };
}

export function resolvedPassengers(
  request: ResolveHoldPassengersRequest,
  version = 1,
): ResolveHoldPassengersResponse {
  return {
    passengers: request.passengerRefs.map((passengerRef, index) => ({
      passengerRef,
      displayName: index === 0 ? 'Ahmed Hassan' : 'Mona Mahmoud',
      maskedNationalId: `**********${String(1000 + index)}`,
      identities: request.tripIds.map((tripId, tripIndex) => ({
        tripId,
        passengerToken: `${version}${index}${tripIndex}`.padEnd(64, 'a'),
        passengerKeyVersion: version,
      })),
    })),
  };
}

export function createRequest(dto: CreateBookingDraftDto): CreateHoldRequest {
  const passengers = resolvedPassengers({
    ownerId: dto.userId,
    passengerRefs: dto.passengerIds,
    tripIds: dto.legs!.map((leg) => leg.tripId),
  }).passengers;
  return {
    ownerId: dto.userId,
    bookingKey: dto.bookingKey,
    legs: dto.legs!,
    passengers: passengers.map(({ passengerRef, identities }) => ({
      passengerRef,
      identities,
    })),
  };
}

export function inventorySnapshot(
  request: CreateHoldRequest,
  outcomes: AllocationOutcome[] = request.legs.map(
    () => AllocationOutcome.SIDE_BY_SIDE,
  ),
): HoldSnapshot {
  const legs = request.legs.map((leg, index) => ({
    ...leg,
    originPosition: 0,
    destinationPosition: 3,
    outcome: outcomes[index],
  }));
  return {
    holdId: HOLD_ID,
    ownerId: request.ownerId,
    bookingKey: request.bookingKey,
    state: 'HELD',
    version: 1,
    extensionUsed: false,
    expiresAt: EXPIRES_AT,
    serverNow: SERVER_NOW,
    allocationOutcome: outcomes.includes(AllocationOutcome.SPLIT)
      ? AllocationOutcome.SPLIT
      : outcomes.includes(AllocationOutcome.SAME_COACH)
        ? AllocationOutcome.SAME_COACH
        : AllocationOutcome.SIDE_BY_SIDE,
    legs,
    assignments: legs.flatMap((leg, legIndex) =>
      request.passengers.map((passenger, index) => ({
        ...leg,
        passengerRef: passenger.passengerRef,
        passengerKeyVersion: passenger.identities.find(
          (identity) => identity.tripId === leg.tripId,
        )!.passengerKeyVersion,
        tripSeatId: `70000000-0000-4000-8000-${String(legIndex * 4 + index + 1).padStart(12, '0')}`,
        coachNumber: leg.outcome === AllocationOutcome.SPLIT ? index + 1 : 5,
        seatNumber: String(44 + index),
        rowNumber: 10,
      })),
    ),
  };
}

export function holdEvent(
  snapshot: HoldSnapshot,
  type: string = HOLD_HELD_EVENT_TYPE,
  reason: HoldLifecyclePayloadV1['reason'] = 'held',
): EventEnvelope<string, HoldLifecyclePayloadV1> {
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: SERVER_NOW,
    producer: 'inventory',
    correlationId: randomUUID(),
    payload: {
      holdId: snapshot.holdId,
      bookingKey: snapshot.bookingKey,
      ownerId: snapshot.ownerId,
      aggregateVersion: snapshot.version,
      state: snapshot.state,
      allocationOutcome: snapshot.allocationOutcome,
      expiresAt: snapshot.expiresAt,
      extensionUsed: snapshot.extensionUsed,
      reason,
      legs: snapshot.legs,
    },
  };
}

/** Exercises production store transitions; PostgreSQL tests prove actual locking. */
export function memoryDraftStore(): {
  store: BookingDraftStore;
  rows: Map<string, BookingDraftEntity>;
  repository: Repository<BookingDraftEntity>;
  isLocked: () => boolean;
} {
  const rows = new Map<string, BookingDraftEntity>();
  let locked = false;
  let tail = Promise.resolve();
  const find = (
    where: Partial<BookingDraftEntity>,
  ): BookingDraftEntity | null => {
    const row = rows.get(where.id!);
    return row && (!where.userId || row.userId === where.userId)
      ? structuredClone(row)
      : null;
  };
  const repository = {
    createQueryBuilder: () => {
      let value: Partial<BookingDraftEntity>;
      const builder = {
        insert: () => builder,
        into: () => builder,
        orIgnore: () => builder,
        values: (input: Partial<BookingDraftEntity>) => {
          value = input;
          return builder;
        },
        execute: async () => {
          if (!rows.has(value.id!))
            rows.set(value.id!, {
              createdAt: new Date(SERVER_NOW),
              passengerSnapshot: null,
              holdRequested: false,
              releaseRequested: false,
              holdId: null,
              holdState: null,
              holdVersion: 0,
              holdSnapshot: null,
              holdServerNow: null,
              extensionUsed: false,
              holdFailure: null,
              ...structuredClone(value),
            } as BookingDraftEntity);
        },
      };
      return builder;
    },
    findOneBy: async (where: Partial<BookingDraftEntity>) => find(where),
    findOneByOrFail: async (where: Partial<BookingDraftEntity>) => {
      const value = find(where);
      if (!value) throw new Error('not found');
      return value;
    },
    findOne: async ({ where }: { where: Partial<BookingDraftEntity> }) =>
      find(where),
    save: async (draft: BookingDraftEntity) => {
      rows.set(draft.id, structuredClone(draft));
      return draft;
    },
    manager: {
      transaction: async <T>(
        work: (manager: { getRepository: () => unknown }) => Promise<T>,
      ) => {
        const waiting = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await waiting;
        locked = true;
        const previous = structuredClone(rows);
        try {
          return await work({ getRepository: () => repository });
        } catch (error) {
          rows.clear();
          previous.forEach((value, key) => rows.set(key, value));
          throw error;
        } finally {
          locked = false;
          release();
        }
      },
    },
  };
  return {
    store: new BookingDraftStore(
      repository as unknown as Repository<BookingDraftEntity>,
    ),
    rows,
    repository: repository as unknown as Repository<BookingDraftEntity>,
    isLocked: () => locked,
  };
}
