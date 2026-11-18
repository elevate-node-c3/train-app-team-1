import { describe, expect, it, vi } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';

import {
  AllocationOutcome,
  ErrorCode,
  type CreateHoldRequest,
  type HoldSnapshot,
} from '@app/contracts';

import { HoldCoreError } from './hold-core.errors.js';
import { SeatHoldGrpcController } from './seat-hold.grpc.controller.js';

const BOOKING_KEY = 'booking-key-1';
const OWNER_ID = '70000000-0000-0000-0000-000000000001';
const TRIP_ID = '10000000-0000-0000-0000-000000000001';

const request: CreateHoldRequest = {
  ownerId: OWNER_ID,
  bookingKey: BOOKING_KEY,
  legs: [
    {
      tripId: TRIP_ID,
      travelClassId: '50000000-0000-0000-0000-000000000001',
      originStationId: '20000000-0000-0000-0000-000000000000',
      destinationStationId: '20000000-0000-0000-0000-000000000002',
    },
  ],
  passengers: [
    {
      passengerRef: 'p-1',
      identities: [
        {
          tripId: TRIP_ID,
          passengerToken: 'trip-token',
          passengerKeyVersion: 1,
        },
      ],
    },
  ],
};

const snapshot: HoldSnapshot = {
  holdId: '80000000-0000-0000-0000-000000000001',
  bookingKey: BOOKING_KEY,
  ownerId: OWNER_ID,
  state: 'HELD',
  version: 1,
  extensionUsed: false,
  expiresAt: '2026-11-15T12:15:00.000Z',
  serverNow: '2026-11-15T12:00:00.000Z',
  allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
  legs: [],
  assignments: [],
};

function buildController(correlationId: string | undefined = 'corr-1') {
  const core = {
    createHold: vi.fn(),
    getHold: vi.fn(),
    releaseHold: vi.fn(),
    extendHold: vi.fn(),
  };
  const cls = { get: vi.fn().mockReturnValue(correlationId) };

  return {
    controller: new SeatHoldGrpcController(
      core as never,
      cls as never,
    ),
    core,
    cls,
  };
}

async function expectRpcError(
  run: () => Promise<unknown>,
  expected: { code: number; details: string; message: string },
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual(expected);
    return;
  }

  throw new Error('Expected an RpcException.');
}

describe('SeatHoldGrpcController hold RPCs', () => {
  it('never sends raw database errors or identity values over gRPC', async () => {
    const { controller, core } = buildController();
    core.createHold.mockRejectedValue(
      new Error('SQL passenger_token=private-token nationalId=29001018888888'),
    );
    await expectRpcError(() => controller.createHold(request), {
      code: grpc.status.INTERNAL,
      details: JSON.stringify({ code: ErrorCode.INTERNAL_SERVER_ERROR }),
      message: 'The hold operation could not be completed.',
    });
  });
  it('delegates CreateHold with the interceptor correlation id', async () => {
    const { controller, core } = buildController('corr-abc');
    core.createHold.mockResolvedValue(snapshot);

    await expect(controller.createHold(request)).resolves.toBe(snapshot);
    expect(core.createHold).toHaveBeenCalledWith(request, 'corr-abc');
  });

  it('delegates GetHold, ReleaseHold, and ExtendHold by key', async () => {
    const { controller, core } = buildController('corr-def');
    core.getHold.mockResolvedValue(snapshot);
    core.releaseHold.mockResolvedValue({ ...snapshot, state: 'RELEASED' });
    core.extendHold.mockResolvedValue({
      ...snapshot,
      version: 2,
      extensionUsed: true,
    });

    const key = { ownerId: OWNER_ID, bookingKey: BOOKING_KEY };

    await controller.getHold(key);
    await controller.releaseHold(key);
    await controller.extendHold(key);

    expect(core.getHold).toHaveBeenCalledWith(key, 'corr-def');
    expect(core.releaseHold).toHaveBeenCalledWith(key, 'corr-def');
    expect(core.extendHold).toHaveBeenCalledWith(key, 'corr-def');
  });

  it('maps SEAT_TAKEN to ABORTED with a machine-readable code', async () => {
    const { controller, core } = buildController();
    core.createHold.mockRejectedValue(
      new HoldCoreError(ErrorCode.SEAT_TAKEN, 'A seat was just taken.'),
    );

    await expectRpcError(() => controller.createHold(request), {
      code: grpc.status.ABORTED,
      details: JSON.stringify({ code: ErrorCode.SEAT_TAKEN }),
      message: 'A seat was just taken.',
    });
  });

  it('maps PASSENGER_OVERLAP to ABORTED with the submitted passenger ref', async () => {
    const { controller, core } = buildController();
    core.createHold.mockRejectedValue(
      new HoldCoreError(
        ErrorCode.PASSENGER_OVERLAP,
        'A passenger already has an overlapping claim.',
        undefined,
        'p-1',
      ),
    );

    await expectRpcError(() => controller.createHold(request), {
      code: grpc.status.ABORTED,
      details: JSON.stringify({
        code: ErrorCode.PASSENGER_OVERLAP,
        passengerRef: 'p-1',
      }),
      message: 'A passenger already has an overlapping claim.',
    });
  });

  it('maps SALES_CLOSED to FAILED_PRECONDITION', async () => {
    const { controller, core } = buildController();
    core.createHold.mockRejectedValue(
      new HoldCoreError(ErrorCode.SALES_CLOSED, 'Sales are closed.'),
    );

    await expectRpcError(() => controller.createHold(request), {
      code: grpc.status.FAILED_PRECONDITION,
      details: JSON.stringify({ code: ErrorCode.SALES_CLOSED }),
      message: 'Sales are closed.',
    });
  });

  it('maps HOLD_NOT_FOUND to NOT_FOUND', async () => {
    const { controller, core } = buildController();
    core.getHold.mockRejectedValue(
      new HoldCoreError(ErrorCode.HOLD_NOT_FOUND, 'No hold.'),
    );

    await expectRpcError(
      () =>
        controller.getHold({
          ownerId: OWNER_ID,
          bookingKey: BOOKING_KEY,
        }),
      {
        code: grpc.status.NOT_FOUND,
        details: JSON.stringify({ code: ErrorCode.HOLD_NOT_FOUND }),
        message: 'No hold.',
      },
    );
  });

  it('maps VALIDATION_ERROR to INVALID_ARGUMENT', async () => {
    const { controller, core } = buildController();
    core.createHold.mockRejectedValue(
      new HoldCoreError(ErrorCode.VALIDATION_ERROR, 'Bad request.'),
    );

    await expectRpcError(() => controller.createHold(request), {
      code: grpc.status.INVALID_ARGUMENT,
      details: JSON.stringify({ code: ErrorCode.VALIDATION_ERROR }),
      message: 'Bad request.',
    });
  });
});
