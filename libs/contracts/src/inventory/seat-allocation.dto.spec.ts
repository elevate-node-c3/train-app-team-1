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

const SPLIT_NOTICE_KEYS: Record<keyof SplitNoticePayload, true> = {
  code: true,
  message: true,
  messageEn: true,
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

    it('declares its unary RPCs on InventoryService', () => {
      const service = serviceDefinition();
      expect(service).toBeDefined();

      // Hold creation lives on the MT-02 lifecycle RPCs, covered by
      // seat-hold.dto.spec.ts; no legacy HoldSeats/ReleaseSeats pair remains.
      const rpcNames = ['SeatUsageForTrips', 'CreateHold', 'GetHold'];
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

    it('keeps SplitNoticePayload fields in step with TypeScript interface', () => {
      expect(fieldNamesOf('SplitNoticePayload').sort()).toEqual(
        Object.keys(SPLIT_NOTICE_KEYS).sort(),
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
});
