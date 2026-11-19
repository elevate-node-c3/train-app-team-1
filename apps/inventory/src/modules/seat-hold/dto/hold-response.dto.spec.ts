import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AllocationOutcome, type HoldSnapshot } from '@app/contracts';

import { HoldSnapshotResponseDto } from './hold-response.dto.js';

const OWNER_ID = '70000000-0000-4000-8000-000000000001';
const TRIP_ID = '10000000-0000-4000-8000-000000000001';

function snapshot(): HoldSnapshot {
  return {
    holdId: '80000000-0000-4000-8000-000000000001',
    bookingKey: 'booking-key-1',
    ownerId: OWNER_ID,
    state: 'HELD',
    version: 1,
    extensionUsed: false,
    expiresAt: '2026-11-19T12:15:00.000Z',
    serverNow: '2026-11-19T12:00:00.000Z',
    allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
    legs: [
      {
        tripId: TRIP_ID,
        travelClassId: '50000000-0000-4000-8000-000000000001',
        originStationId: '20000000-0000-4000-8000-000000000000',
        destinationStationId: '20000000-0000-4000-8000-000000000002',
        originPosition: 0,
        destinationPosition: 2,
        outcome: AllocationOutcome.SIDE_BY_SIDE,
      },
    ],
    assignments: [
      {
        passengerRef: 'p-1',
        passengerKeyVersion: 1,
        tripId: TRIP_ID,
        tripSeatId: '90000000-0000-4000-8000-000000000001',
        travelClassId: '50000000-0000-4000-8000-000000000001',
        coachNumber: 1,
        seatNumber: '12A',
        rowNumber: 12,
        outcome: AllocationOutcome.SIDE_BY_SIDE,
        originStationId: '20000000-0000-4000-8000-000000000000',
        destinationStationId: '20000000-0000-4000-8000-000000000002',
        originPosition: 0,
        destinationPosition: 2,
      },
    ],
  };
}

/** The field names inventory.proto declares for a message. */
function protoFields(message: string): string[] {
  const proto = readFileSync(
    'libs/contracts/src/proto/inventory.proto',
    'utf8',
  );
  const body = new RegExp(`message ${message} \\{([^}]*)\\}`).exec(proto)?.[1];
  if (!body) throw new Error(`${message} is not in inventory.proto`);

  return [...body.matchAll(/^\s*(?:optional |repeated )?[\w.]+ (\w+) = \d+;/gm)]
    .map((match) => match[1])
    .sort();
}

describe('hold response DTO', () => {
  it('carries every field the snapshot answers with', () => {
    const response = HoldSnapshotResponseDto.from(snapshot());

    expect(response).toBeInstanceOf(HoldSnapshotResponseDto);
    expect(response).toEqual(snapshot());
  });

  it('declares exactly what inventory.proto declares', () => {
    const response = HoldSnapshotResponseDto.from(snapshot());

    // The proto calls them HoldView and HoldLegView; the TS types are
    // HoldSnapshot and HoldLegResult. Same fields, different names.
    expect(Object.keys(response).sort()).toEqual(protoFields('HoldView'));
    expect(Object.keys(response.legs[0]).sort()).toEqual(
      protoFields('HoldLegView'),
    );
    expect(Object.keys(response.assignments[0]).sort()).toEqual(
      protoFields('HoldSeatAssignment'),
    );
  });

  it('drops a column a widened query dragged in', () => {
    const leaky = {
      ...snapshot(),
      passengerToken: 'trip-scoped-hmac',
      assignments: [
        {
          ...snapshot().assignments[0],
          passengerToken: 'trip-scoped-hmac',
          nationalId: '29001011234567',
        },
      ],
    } as unknown as HoldSnapshot;

    const wire = JSON.stringify(HoldSnapshotResponseDto.from(leaky));

    expect(wire).not.toContain('trip-scoped-hmac');
    expect(wire).not.toContain('29001011234567');
    expect(wire).not.toContain('passengerToken');
  });

  it('keeps a null expiry and a null outcome, which mean something', () => {
    const response = HoldSnapshotResponseDto.from({
      ...snapshot(),
      state: 'CANCELLED',
      expiresAt: null,
      allocationOutcome: null,
      assignments: [],
    });

    expect(response.expiresAt).toBeNull();
    expect(response.allocationOutcome).toBeNull();
    expect(response.assignments).toEqual([]);
  });

  it('does not turn an absent seat label into a null', () => {
    const response = HoldSnapshotResponseDto.from(snapshot());

    // A declared optional field exists as undefined, which gRPC and
    // JSON.stringify both leave out. Null would mean "no label".
    expect(response.assignments[0].label).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('label');
  });

  it('carries a split notice in both languages when a leg split', () => {
    const response = HoldSnapshotResponseDto.from({
      ...snapshot(),
      legs: [
        {
          ...snapshot().legs[0],
          outcome: AllocationOutcome.SPLIT,
          splitNotice: {
            code: 'SEATS_SPLIT',
            message: 'لم نتمكن من جلوسكم معاً.',
            messageEn: 'We could not seat you together.',
          },
        },
      ],
    });

    expect(response.legs[0].splitNotice).toEqual({
      code: 'SEATS_SPLIT',
      message: 'لم نتمكن من جلوسكم معاً.',
      messageEn: 'We could not seat you together.',
    });
  });
});
