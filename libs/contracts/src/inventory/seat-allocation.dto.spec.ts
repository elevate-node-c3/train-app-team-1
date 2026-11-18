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
  SEATS_SPLIT_NOTICE,
  type AssignedSeat,
  type HoldSeatsRequest,
  type HoldSeatsResponse,
  type ReleaseSeatsRequest,
  type ReleaseSeatsResponse,
  type SplitNoticePayload,
} from './seat-allocation.dto.js';
import { ErrorCode } from '../error-codes.enum.js';

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

function messageDescriptor(messageName: string): MessageDescriptor {
  return descriptorOf(messageName) as MessageDescriptor;
}

function enumDescriptor(enumName: string): EnumDescriptor {
  return descriptorOf(enumName) as EnumDescriptor;
}

function serviceDefinition(options?: Options): ServiceDefinition {
  const definition = loadSync(getInventoryProtoPath(), options);
  return definition[
    `${INVENTORY_PACKAGE_NAME}.${INVENTORY_SERVICE_NAME}`
  ] as ServiceDefinition;
}

function fieldNamesOf(messageName: string): string[] {
  return (messageDescriptor(messageName).field ?? []).map(
    (field) => field.name,
  );
}

const HOLD_SEATS_REQUEST_KEYS: Record<keyof HoldSeatsRequest, true> = {
  tripId: true,
  travelClassId: true,
  originStationId: true,
  destinationStationId: true,
  groupSize: true,
  ttlSeconds: true,
  bookingId: true,
};

const ASSIGNED_SEAT_KEYS: Record<keyof AssignedSeat, true> = {
  seatId: true,
  coachNumber: true,
  seatNumber: true,
  rowNumber: true,
  label: true,
};

const SPLIT_NOTICE_KEYS: Record<keyof SplitNoticePayload, true> = {
  code: true,
  message: true,
  messageEn: true,
};

const HOLD_SEATS_RESPONSE_KEYS: Record<keyof HoldSeatsResponse, true> = {
  holdId: true,
  allocationOutcome: true,
  seats: true,
  expiresAt: true,
  splitNotice: true,
};

const RELEASE_SEATS_REQUEST_KEYS: Record<keyof ReleaseSeatsRequest, true> = {
  holdId: true,
};

const RELEASE_SEATS_RESPONSE_KEYS: Record<keyof ReleaseSeatsResponse, true> = {
  success: true,
};

describe('Seat Allocation and Hold Contracts', () => {
  describe('Barrel re-exports', () => {
    it('re-exports seat allocation contracts from @app/contracts barrel', async () => {
      const barrel = await import('../index.js');

      expect(barrel).toHaveProperty('AllocationOutcome');
      expect(barrel).toHaveProperty('SEATS_SPLIT_NOTICE');
      expect(barrel.ErrorCode).toHaveProperty('INSUFFICIENT_SEATS');
      expect(barrel.ErrorCode).toHaveProperty('SEAT_ALREADY_TAKEN');
    });
  });

  describe('AllocationOutcome enum', () => {
    it('defines the three tier outcomes with exact string values', () => {
      expect(AllocationOutcome.SIDE_BY_SIDE).toBe('SIDE_BY_SIDE');
      expect(AllocationOutcome.SAME_COACH).toBe('SAME_COACH');
      expect(AllocationOutcome.SPLIT).toBe('SPLIT');
    });
  });

  describe('Bilingual SEATS_SPLIT_NOTICE constant', () => {
    it('matches the mandated Arabic and English default copy', () => {
      expect(SEATS_SPLIT_NOTICE).toEqual({
        code: 'SEATS_SPLIT_NOTICE',
        message: 'تم توزيع المقاعد عبر أكثر من عربة لعدم توفر مقاعد متجاورة كافية',
        messageEn:
          'Seats have been split across coaches because consecutive seats were unavailable',
      });
    });

    it('is immutable', () => {
      expect(Object.isFrozen(SEATS_SPLIT_NOTICE)).toBe(true);
    });
  });

  describe('Error codes', () => {
    it('defines INSUFFICIENT_SEATS and SEAT_ALREADY_TAKEN error codes', () => {
      expect(ErrorCode.INSUFFICIENT_SEATS).toBe('INSUFFICIENT_SEATS');
      expect(ErrorCode.SEAT_ALREADY_TAKEN).toBe('SEAT_ALREADY_TAKEN');
    });
  });

  describe('Proto definition & gRPC service', () => {
    it('resolves inventory.proto path and file exists', () => {
      const protoPath = getInventoryProtoPath();
      expect(protoPath.endsWith('inventory.proto')).toBe(true);
      expect(existsSync(protoPath)).toBe(true);
    });

    it('declares HoldSeats and ReleaseSeats unary RPCs on InventoryService', () => {
      const service = serviceDefinition();
      expect(service).toBeDefined();

      const rpcNames = ['SeatUsageForTrips', 'HoldSeats', 'ReleaseSeats'];
      for (const name of rpcNames) {
        const method = service[name];
        expect(method, `RPC ${name} is missing from InventoryService`).toBeDefined();
        expect(method.path).toBe(
          `/${INVENTORY_PACKAGE_NAME}.${INVENTORY_SERVICE_NAME}/${name}`,
        );
        expect(method.requestStream).toBe(false);
        expect(method.responseStream).toBe(false);
      }
    });

    it('keeps HoldSeatsRequest fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('HoldSeatsRequest').sort()).toEqual(
        Object.keys(HOLD_SEATS_REQUEST_KEYS).sort(),
      );
    });

    it('keeps AssignedSeat fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('AssignedSeat').sort()).toEqual(
        Object.keys(ASSIGNED_SEAT_KEYS).sort(),
      );
    });

    it('keeps SplitNoticePayload fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('SplitNoticePayload').sort()).toEqual(
        Object.keys(SPLIT_NOTICE_KEYS).sort(),
      );
    });

    it('keeps HoldSeatsResponse fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('HoldSeatsResponse').sort()).toEqual(
        Object.keys(HOLD_SEATS_RESPONSE_KEYS).sort(),
      );
    });

    it('keeps ReleaseSeatsRequest fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('ReleaseSeatsRequest').sort()).toEqual(
        Object.keys(RELEASE_SEATS_REQUEST_KEYS).sort(),
      );
    });

    it('keeps ReleaseSeatsResponse fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('ReleaseSeatsResponse').sort()).toEqual(
        Object.keys(RELEASE_SEATS_RESPONSE_KEYS).sort(),
      );
    });

    it('defines AllocationOutcome enum in proto matching TypeScript values', () => {
      const enumDesc = enumDescriptor('AllocationOutcome');
      expect(enumDesc.value).toBeDefined();

      const byNumber = new Map(
        (enumDesc.value ?? []).map((v) => [v.number, v.name]),
      );
      expect(byNumber.get(0)).toBe('ALLOCATION_OUTCOME_UNSPECIFIED');
      expect(byNumber.get(1)).toBe('SIDE_BY_SIDE');
      expect(byNumber.get(2)).toBe('SAME_COACH');
      expect(byNumber.get(3)).toBe('SPLIT');
    });
  });

  describe('gRPC Serialization and Deserialization', () => {
    it('round-trips HoldSeatsRequest', () => {
      const service = serviceDefinition();
      const request: HoldSeatsRequest = {
        tripId: '11111111-1111-4111-8111-111111111111',
        travelClassId: '22222222-2222-4222-8222-222222222222',
        originStationId: '33333333-3333-4333-8333-333333333333',
        destinationStationId: '44444444-4444-4444-8444-444444444444',
        groupSize: 3,
        ttlSeconds: 600,
        bookingId: '55555555-5555-4555-8555-555555555555',
      };

      const encoded = service.HoldSeats.requestSerialize(request);
      const decoded = service.HoldSeats.requestDeserialize(encoded);
      expect(decoded).toEqual(request);
    });

    it('round-trips HoldSeatsResponse with SIDE_BY_SIDE outcome and no notice', () => {
      const service = serviceDefinition({ enums: String, defaults: false });
      const response: HoldSeatsResponse = {
        holdId: 'hold-123',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 3,
            seatNumber: '12',
            rowNumber: 3,
            label: 'Coach 3 · Seat 12',
          },
          {
            seatId: 'seat-2',
            coachNumber: 3,
            seatNumber: '13',
            rowNumber: 3,
            label: 'Coach 3 · Seat 13',
          },
        ],
        expiresAt: '2026-11-14T20:30:00.000Z',
      };

      const encoded = service.HoldSeats.responseSerialize(response);
      const decoded = service.HoldSeats.responseDeserialize(encoded);
      expect(decoded).toEqual(response);
    });

    it('round-trips HoldSeatsResponse with SPLIT outcome and SEATS_SPLIT_NOTICE', () => {
      const service = serviceDefinition({ enums: String, defaults: false });
      const response: HoldSeatsResponse = {
        holdId: 'hold-456',
        allocationOutcome: AllocationOutcome.SPLIT,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 2,
            seatNumber: '5',
            rowNumber: 2,
            label: 'Coach 2 · Seat 5',
          },
          {
            seatId: 'seat-2',
            coachNumber: 4,
            seatNumber: '8',
            rowNumber: 2,
            label: 'Coach 4 · Seat 8',
          },
        ],
        expiresAt: '2026-11-14T20:30:00.000Z',
        splitNotice: SEATS_SPLIT_NOTICE,
      };

      const encoded = service.HoldSeats.responseSerialize(response);
      const decoded = service.HoldSeats.responseDeserialize(encoded);
      expect(decoded).toEqual(response);
    });

    it('round-trips ReleaseSeatsRequest and ReleaseSeatsResponse', () => {
      const service = serviceDefinition();
      const request: ReleaseSeatsRequest = {
        holdId: 'hold-123',
      };
      const response: ReleaseSeatsResponse = {
        success: true,
      };

      const encodedReq = service.ReleaseSeats.requestSerialize(request);
      const decodedReq = service.ReleaseSeats.requestDeserialize(encodedReq);
      expect(decodedReq).toEqual(request);

      const encodedRes = service.ReleaseSeats.responseSerialize(response);
      const decodedRes = service.ReleaseSeats.responseDeserialize(encodedRes);
      expect(decodedRes).toEqual(response);
    });
  });
});
