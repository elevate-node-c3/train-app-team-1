import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';

import { CALLER_ACCOUNT_ID_KEY } from '@app/common';
import { ErrorCode } from '@app/contracts';

import { CatalogSearchError } from '../trips/catalog-search-error.js';
import type { FareChangeService } from './fare-change.service.js';
import type { OperationsAuditService } from './operations-audit.service.js';
import {
  OperationsGrpcController,
  type PublishTimetableRpcRequest,
} from './operations.grpc.controller.js';
import type { TimetablePublishService } from './timetable-publish.service.js';

/** The operator the gateway's metadata would have put in CLS. */
const ACTOR = '66666666-6666-4666-8666-666666666666';

function metadataWith(idempotencyKey?: string): Metadata {
  const metadata = new Metadata();
  if (idempotencyKey) metadata.set('idempotency-key', idempotencyKey);
  return metadata;
}

function controllerWith(options: {
  publish?: Partial<TimetablePublishService>;
  fareChange?: Partial<FareChangeService>;
  audit?: Partial<OperationsAuditService>;
  caller?: Record<string, unknown>;
}) {
  const caller = options.caller ?? { [CALLER_ACCOUNT_ID_KEY]: ACTOR };
  return new OperationsGrpcController(
    (options.publish ?? {}) as TimetablePublishService,
    (options.fareChange ?? {}) as FareChangeService,
    (options.audit ?? {}) as OperationsAuditService,
    { get: (key: string) => caller[key] } as never,
  );
}

const publishRequest: PublishTimetableRpcRequest = {
  trainNumber: '101',
  runningDays: [1, 2, 3, 4, 5],
  effectiveFrom: '2026-07-01',
  stops: [
    { stationId: 's1', position: 1, dayOffset: 0, departureTime: '08:00' },
    { stationId: 's2', position: 2, dayOffset: 0, arrivalTime: '10:00' },
  ],
  coaches: [
    { position: 1, coachNumber: 1, travelClassId: 'tc1', coachLayoutId: 'cl1' },
  ],
  fares: [
    {
      travelClassId: 'tc1',
      originStationId: 's1',
      destinationStationId: 's2',
      amountPiastres: 1000,
    },
  ],
};

const changeFareRequest = {
  trainNumber: '101',
  travelClassId: 'tc1',
  originStationId: 's1',
  destinationStationId: 's2',
  amountPiastres: 1200,
  effectiveFrom: '2026-07-01T00:00:00.000Z',
};

describe('OperationsGrpcController', () => {
  it('publishes a timetable for the caller in the metadata', async () => {
    const publish = vi.fn().mockResolvedValue({
      timetableId: 't1',
      version: 1,
      created: 1,
      changed: 0,
      withdrawn: 0,
    });

    const response = await controllerWith({
      publish: { publish } as Partial<TimetablePublishService>,
    }).publishTimetable(publishRequest, metadataWith('key-1'));

    expect(response).toMatchObject({
      timetableId: 't1',
      version: 1,
      created: 1,
    });

    // Absent wire fields become `null`, matching the domain type.
    expect(publish.mock.calls[0][0]).toMatchObject({
      trainNumber: '101',
      stops: [
        expect.objectContaining({ stationId: 's1', arrivalTime: null }),
        expect.objectContaining({ stationId: 's2', departureTime: null }),
      ],
    });
    expect(publish.mock.calls[0][1]).toBe('key-1');
    expect(publish.mock.calls[0][2]).toBe(ACTOR);
  });

  it('changes a fare for the caller in the metadata', async () => {
    const changeFare = vi.fn().mockResolvedValue({
      fareId: 'f1',
      previousAmountPiastres: 1000,
      newAmountPiastres: 1200,
      effectiveFrom: changeFareRequest.effectiveFrom,
    });

    const response = await controllerWith({
      fareChange: { changeFare } as Partial<FareChangeService>,
    }).changeFare(changeFareRequest, metadataWith('key-2'));

    expect(response).toMatchObject({ fareId: 'f1', newAmountPiastres: 1200 });
    expect(changeFare.mock.calls[0][0]).toBe(changeFareRequest);
    expect(changeFare.mock.calls[0][1]).toBe('key-2');
    expect(changeFare.mock.calls[0][2]).toBe(ACTOR);
  });

  it('lists audit entries newest first', async () => {
    const older = {
      id: 'a1',
      action: 'timetable.published' as const,
      actorAccountId: ACTOR,
      trainId: 'tr1',
      before: null,
      after: { version: 1 },
      ticketsAffected: 0,
      correlationId: 'c1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
    };
    const newer = {
      ...older,
      id: 'a2',
      action: 'fare.changed' as const,
      correlationId: 'c2',
      occurredAt: new Date('2026-02-01T00:00:00Z'),
    };
    const list = vi
      .fn()
      .mockResolvedValue({ entries: [newer, older], nextCursor: null });

    const response = await controllerWith({
      audit: { list } as Partial<OperationsAuditService>,
    }).listAuditEntries({});

    expect(response.entries.map((entry) => entry.id)).toEqual(['a2', 'a1']);
    expect(response.entries[0].beforeJson).toBe('null');
    expect(response.entries[1].afterJson).toBe(JSON.stringify({ version: 1 }));
    expect(response.nextCursor).toBeUndefined();
    // Normalize missing limits before the repository's limit + 1 pagination.
    expect(list.mock.calls[0][0].limit).toBeGreaterThan(0);
  });

  it('narrows audit entries by train, date range and cursor', async () => {
    const list = vi.fn().mockResolvedValue({ entries: [], nextCursor: null });

    await controllerWith({
      audit: { list } as Partial<OperationsAuditService>,
    }).listAuditEntries({
      trainId: 'tr1',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      limit: 5,
      cursor: 'a9',
    });

    expect(list.mock.calls[0][0]).toMatchObject({
      trainId: 'tr1',
      limit: 5,
      cursor: 'a9',
    });
    expect(list.mock.calls[0][0].from).toBeInstanceOf(Date);
    expect(list.mock.calls[0][0].to).toBeInstanceOf(Date);
  });

  describe('a missing actor or idempotency key', () => {
    it('refuses an rpc with no caller account id', async () => {
      const publish = vi.fn();
      const controller = controllerWith({
        publish: { publish } as Partial<TimetablePublishService>,
        caller: {},
      });

      const error = await controller
        .publishTimetable(publishRequest, metadataWith('key-1'))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as { details: string };
      expect(JSON.parse(payload.details)).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [
          {
            field: 'callerAccountId',
            issueKey: 'ISSUE_CALLER_ACCOUNT_MISSING',
            actionKey: 'ACTION_SIGN_IN_AND_RETRY',
          },
        ],
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('refuses an rpc with no idempotency key', async () => {
      const publish = vi.fn();
      const controller = controllerWith({
        publish: { publish } as Partial<TimetablePublishService>,
      });

      const error = await controller
        .publishTimetable(publishRequest, metadataWith())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as { details: string };
      expect(JSON.parse(payload.details)).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [
          {
            field: 'Idempotency-Key',
            issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
            actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
          },
        ],
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('refuses changeFare the same way with no caller account id', async () => {
      const changeFare = vi.fn();
      const controller = controllerWith({
        fareChange: { changeFare } as Partial<FareChangeService>,
        caller: {},
      });

      const error = await controller
        .changeFare(changeFareRequest, metadataWith('key-3'))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      expect(changeFare).not.toHaveBeenCalled();
    });

    it('refuses changeFare the same way with no idempotency key', async () => {
      const changeFare = vi.fn();
      const controller = controllerWith({
        fareChange: { changeFare } as Partial<FareChangeService>,
      });

      const error = await controller
        .changeFare(changeFareRequest, metadataWith())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      expect(changeFare).not.toHaveBeenCalled();
    });
  });

  it('carries the refusal code and details in the gRPC status', async () => {
    const refusal = new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'trainNumber',
        rejectedValue: '999',
        issueKey: 'ISSUE_TRAIN_NUMBER_NOT_KNOWN',
        actionKey: 'ACTION_PICK_TRAIN_FROM_LIST',
      },
    ]);
    const publish = vi.fn().mockRejectedValue(refusal);

    const error = (await controllerWith({
      publish: { publish } as Partial<TimetablePublishService>,
    })
      .publishTimetable(publishRequest, metadataWith('key-1'))
      .catch((caught: unknown) => caught)) as RpcException;

    expect(error).toBeInstanceOf(RpcException);
    const payload = error.getError() as { details: string };
    expect(JSON.parse(payload.details)).toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      details: refusal.details,
    });
  });

  it('leaves an unexpected error alone', async () => {
    const boom = new Error('connection reset');
    const publish = vi.fn().mockRejectedValue(boom);

    const error = await controllerWith({
      publish: { publish } as Partial<TimetablePublishService>,
    })
      .publishTimetable(publishRequest, metadataWith('key-1'))
      .catch((caught: unknown) => caught);

    expect(error).toBe(boom);
  });
});
