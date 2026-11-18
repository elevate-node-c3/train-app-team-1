import { existsSync } from 'node:fs';
import {
  loadSync,
  type Options,
  type ServiceDefinition,
} from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import {
  INVENTORY_PACKAGE_NAME,
  INVENTORY_SERVICE_NAME,
  getInventoryProtoPath,
} from './inventory.grpc.js';
import {
  AllocationOutcome,
} from './seat-allocation.dto.js';
import {
  composeAllocationOutcome,
  type CreateHoldRequest,
  type HoldLegInput,
  type HoldPassengerInput,
  type HoldSeatAssignment,
  type HoldSnapshot,
} from './seat-hold.dto.js';
import { ErrorCode } from '../error-codes.enum.js';
import {
  HOLD_LIFECYCLE_PAYLOAD_KEYS,
} from '../events/hold-events.js';

interface MessageDescriptor {
  field?: {
    name: string;
    type: string;
    number: number;
    typeName?: string;
  }[];
}

interface EnumDescriptor {
  value?: { name: string; number: number }[];
}

function descriptorOf(typeName: string): object {
  const definition = loadSync(getInventoryProtoPath());
  const entry = definition[`${INVENTORY_PACKAGE_NAME}.${typeName}`];

  if (entry === undefined || !('type' in entry)) {
    throw new Error(`${typeName} is not a message or enum in the descriptor`);
  }

  return entry.type;
}

function fieldNamesOf(messageName: string): string[] {
  return ((descriptorOf(messageName) as MessageDescriptor).field ?? []).map(
    (field) => field.name,
  );
}

function enumNamesOf(enumName: string): string[] {
  return ((descriptorOf(enumName) as EnumDescriptor).value ?? []).map(
    (value) => value.name,
  );
}

function serviceDefinition(options?: Options): ServiceDefinition {
  const definition = loadSync(getInventoryProtoPath(), options);
  return definition[
    `${INVENTORY_PACKAGE_NAME}.${INVENTORY_SERVICE_NAME}`
  ] as ServiceDefinition;
}

describe('MT-02 hold lifecycle contracts', () => {
  it('resolves the inventory proto file', () => {
    const protoPath = getInventoryProtoPath();
    expect(protoPath.endsWith('inventory.proto')).toBe(true);
    expect(existsSync(protoPath)).toBe(true);
  });

  it('exposes create, get, release and extend as the only hold RPCs', () => {
    const service = serviceDefinition({ enums: String });

    // Holds are created only through this lifecycle; no legacy
    // HoldSeats/ReleaseSeats pair remains on the wire.
    expect(Object.keys(service).sort()).toEqual([
      'CreateHold',
      'ExtendHold',
      'GetHold',
      'ReleaseHold',
      'SeatUsageForTrips',
    ]);
  });

  it('keeps the SEAT-2 allocation outcome exhaustive and unchanged', () => {
    expect(enumNamesOf('AllocationOutcome')).toEqual([
      'ALLOCATION_OUTCOME_UNSPECIFIED',
      'SIDE_BY_SIDE',
      'SAME_COACH',
      'SPLIT',
    ]);
    expect(AllocationOutcome.SIDE_BY_SIDE).toBe('SIDE_BY_SIDE');
    expect(AllocationOutcome.SAME_COACH).toBe('SAME_COACH');
    expect(AllocationOutcome.SPLIT).toBe('SPLIT');
  });

  it('defines the effective hold states', () => {
    expect(enumNamesOf('HoldState')).toEqual([
      'HOLD_STATE_UNSPECIFIED',
      'HELD',
      'RELEASED',
      'EXPIRED',
      'CANCELLED',
    ]);
  });

  it('carries owner, immutable key, legs, and passengers on create', () => {
    expect(fieldNamesOf('CreateHoldRequest').sort()).toEqual([
      'bookingKey',
      'legs',
      'ownerId',
      'passengers',
    ]);

    // Client-supplied times and TTLs are deliberately absent.
    const fields = fieldNamesOf('CreateHoldRequest');
    expect(fields).not.toContain('ttlSeconds');
    expect(fields).not.toContain('originDepartureTime');
    expect(fields).not.toContain('groupSize');
    expect(fields).not.toContain('count');
  });

  it('carries one trip-scoped token/version pair per leg', () => {
    expect(fieldNamesOf('HoldPassengerInput').sort()).toEqual([
      'identities',
      'passengerRef',
    ]);
    expect(fieldNamesOf('HoldPassengerLegIdentity').sort()).toEqual([
      'passengerKeyVersion',
      'passengerToken',
      'tripId',
    ]);
  });

  it('identifies each leg by inventory ids only', () => {
    expect(fieldNamesOf('HoldLegInput').sort()).toEqual([
      'destinationStationId',
      'originStationId',
      'travelClassId',
      'tripId',
    ]);
  });

  it('returns effective state, version, expiry, server time, and allocation', () => {
    expect(fieldNamesOf('HoldView').sort()).toEqual([
      'allocationOutcome',
      'assignments',
      'bookingKey',
      'expiresAt',
      'extensionUsed',
      'holdId',
      'legs',
      'ownerId',
      'serverNow',
      'state',
      'version',
    ]);
  });

  it('returns per-passenger/per-leg assignment identity without tokens', () => {
    const fields = fieldNamesOf('HoldSeatAssignment');

    expect(fields).toEqual(
      expect.arrayContaining([
        'passengerRef',
        'passengerKeyVersion',
        'tripId',
        'tripSeatId',
        'travelClassId',
        'coachNumber',
        'seatNumber',
        'rowNumber',
        'outcome',
        'originStationId',
        'destinationStationId',
        'originPosition',
        'destinationPosition',
      ]),
    );
    expect(fields).not.toContain('passengerToken');
  });

  it('keeps TypeScript request/response shapes aligned with proto names', () => {
    const passenger: HoldPassengerInput = {
      passengerRef: 'p-1',
      identities: [
        {
          tripId: '10000000-0000-0000-0000-000000000001',
          passengerToken: 'opaque-token',
          passengerKeyVersion: 1,
        },
      ],
    };
    const leg: HoldLegInput = {
      tripId: '10000000-0000-0000-0000-000000000001',
      travelClassId: '50000000-0000-0000-0000-000000000001',
      originStationId: '20000000-0000-0000-0000-000000000000',
      destinationStationId: '20000000-0000-0000-0000-000000000002',
    };
    const request: CreateHoldRequest = {
      ownerId: '70000000-0000-0000-0000-000000000001',
      bookingKey: 'booking-key-1',
      legs: [leg],
      passengers: [passenger],
    };

    expect(Object.keys(request).sort()).toEqual(
      fieldNamesOf('CreateHoldRequest').sort(),
    );

    const assignment: HoldSeatAssignment = {
      passengerRef: passenger.passengerRef,
      passengerKeyVersion: passenger.identities[0].passengerKeyVersion,
      tripId: leg.tripId,
      tripSeatId: '40000000-0000-0000-0000-000000000001',
      travelClassId: leg.travelClassId,
      coachNumber: 1,
      seatNumber: '1A',
      rowNumber: 1,
      label: 'Coach 1 · Seat 1A',
      outcome: AllocationOutcome.SIDE_BY_SIDE,
      originStationId: leg.originStationId,
      destinationStationId: leg.destinationStationId,
      originPosition: 0,
      destinationPosition: 2,
    };
    const snapshot: HoldSnapshot = {
      holdId: '80000000-0000-0000-0000-000000000001',
      bookingKey: request.bookingKey,
      ownerId: request.ownerId,
      state: 'HELD',
      version: 1,
      extensionUsed: false,
      expiresAt: '2026-11-15T12:15:00.000Z',
      serverNow: '2026-11-15T12:00:00.000Z',
      allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
      legs: [
        {
          ...leg,
          originPosition: 0,
          destinationPosition: 2,
          outcome: AllocationOutcome.SIDE_BY_SIDE,
        },
      ],
      assignments: [assignment],
    };

    expect(Object.keys(snapshot).sort()).toEqual(
      fieldNamesOf('HoldView').sort(),
    );
  });

  it('composes per-leg outcomes without inventing a new tier', () => {
    expect(composeAllocationOutcome([])).toBeNull();
    expect(
      composeAllocationOutcome([AllocationOutcome.SIDE_BY_SIDE]),
    ).toBe(AllocationOutcome.SIDE_BY_SIDE);
    expect(
      composeAllocationOutcome([
        AllocationOutcome.SIDE_BY_SIDE,
        AllocationOutcome.SAME_COACH,
      ]),
    ).toBe(AllocationOutcome.SAME_COACH);
    expect(
      composeAllocationOutcome([
        AllocationOutcome.SIDE_BY_SIDE,
        AllocationOutcome.SPLIT,
      ]),
    ).toBe(AllocationOutcome.SPLIT);
  });

  it('defines the hold business refusals', () => {
    expect(ErrorCode.SEAT_TAKEN).toBe('SEAT_TAKEN');
    expect(ErrorCode.PASSENGER_OVERLAP).toBe('PASSENGER_OVERLAP');
    expect(ErrorCode.SALES_CLOSED).toBe('SALES_CLOSED');
    expect(ErrorCode.HOLD_TERMINAL).toBe('HOLD_TERMINAL');
    expect(ErrorCode.EXTENSION_NOT_ALLOWED).toBe('EXTENSION_NOT_ALLOWED');
    expect(ErrorCode.BOOKING_KEY_CONFLICT).toBe('BOOKING_KEY_CONFLICT');
    expect(ErrorCode.HOLD_NOT_FOUND).toBe('HOLD_NOT_FOUND');
  });

  it('keeps lifecycle event payloads free of tokens and National IDs', () => {
    expect(HOLD_LIFECYCLE_PAYLOAD_KEYS).not.toContain('passengerToken');
    expect(HOLD_LIFECYCLE_PAYLOAD_KEYS).not.toContain('nationalId');
    expect(HOLD_LIFECYCLE_PAYLOAD_KEYS).not.toContain('passengerName');
    expect(HOLD_LIFECYCLE_PAYLOAD_KEYS).not.toContain('mask');
  });
});
