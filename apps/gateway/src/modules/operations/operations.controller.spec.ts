import { STAFF_ROLE_KEY, createValidationPipe } from '@app/common';
import { ErrorCode } from '@app/contracts';
import type { CallOptions } from '@grpc/grpc-js';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { ChangeFareDto } from './dto/change-fare.dto.js';
import type { ListAuditQueryDto } from './dto/list-audit.dto.js';
import { PublishTimetableDto } from './dto/publish-timetable.dto.js';
import { OperationsController } from './operations.controller.js';
import { OperationsGrpcClientService } from './operations.grpc.client.js';
import { OperationsModule } from './operations.module.js';
import {
  OperationsService,
  type PublishTimetableResult,
} from './operations.service.js';
import {
  OPERATIONS_GRPC_CLIENT,
  type OperationsGrpcClient,
  type PublishTimetableGrpcRequest,
  type PublishTimetableGrpcResponse,
} from './operations.types.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const LAYOUT = '44444444-4444-4444-8444-444444444444';

const publishBody = (): PublishTimetableDto => ({
  trainNumber: '916',
  runningDays: [1, 2],
  effectiveFrom: '2026-06-20',
  stops: [
    {
      stationId: CAIRO,
      position: 0,
      dayOffset: 0,
      departureTime: '06:00',
    },
    {
      stationId: ALEX,
      position: 1,
      dayOffset: 0,
      arrivalTime: '09:00',
    },
  ],
  coaches: [
    {
      position: 1,
      coachNumber: 1,
      travelClassId: FIRST,
      coachLayoutId: LAYOUT,
    },
  ],
  fares: [
    {
      travelClassId: FIRST,
      originStationId: CAIRO,
      destinationStationId: ALEX,
      amountPiastres: 15_000,
    },
  ],
});

const fareBody = (): ChangeFareDto => ({
  trainNumber: '916',
  travelClassId: FIRST,
  originStationId: CAIRO,
  destinationStationId: ALEX,
  amountPiastres: 17_500,
  effectiveFrom: '2026-07-01T00:00:00.000Z',
});

const PUBLISH_RESPONSE: PublishTimetableGrpcResponse = {
  timetableId: 'timetable-2',
  version: 2,
  created: 0,
  changed: 4,
  withdrawn: 1,
};

const PUBLISH_RESULT: PublishTimetableResult = {
  timetableId: 'timetable-2',
  version: 2,
  created: 0,
  changed: 4,
  withdrawn: 1,
};

function controllerWith(
  service: Partial<OperationsService>,
): OperationsController {
  return new OperationsController(service as OperationsService);
}

function handler(name: keyof OperationsController): object {
  return Object.getOwnPropertyDescriptor(OperationsController.prototype, name)
    ?.value as object;
}

function clsStub(): ClsService {
  return {
    get: () => undefined,
    set: () => undefined,
  } as unknown as ClsService;
}

function clientWith(
  overrides: Partial<OperationsGrpcClient>,
): OperationsGrpcClientService {
  return new OperationsGrpcClientService(
    overrides as OperationsGrpcClient,
    clsStub(),
  );
}

describe('OperationsController', () => {
  it('requires the operator role on every route', () => {
    for (const route of [
      'publishTimetable',
      'changeFare',
      'listAudit',
    ] as const) {
      expect(
        Reflect.getMetadata(STAFF_ROLE_KEY, handler(route)),
        `${route} must be operator-only`,
      ).toEqual(['operator']);
    }
  });

  it('declares the three routes under operations', () => {
    expect(Reflect.getMetadata('path', OperationsController)).toBe(
      'operations',
    );
    expect(
      Reflect.getMetadata('path', handler('publishTimetable')),
    ).toBe('timetables');
    expect(Reflect.getMetadata('path', handler('changeFare'))).toBe('fares');
    expect(Reflect.getMetadata('path', handler('listAudit'))).toBe('audit');
  });

  it('refuses a request with no Idempotency-Key', async () => {
    const publishTimetable = vi.fn();
    const controller = controllerWith({ publishTimetable });

    const error = await controller
      .publishTimetable(publishBody(), undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const body = exception.getResponse() as {
      code: string;
      message: { field: string }[];
    };
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.message[0].field).toBe('Idempotency-Key');
    expect(publishTimetable).not.toHaveBeenCalled();
  });

  it('refuses a fare change with no Idempotency-Key too', async () => {
    const changeFare = vi.fn();
    const controller = controllerWith({ changeFare });

    await expect(controller.changeFare(fareBody(), undefined)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(changeFare).not.toHaveBeenCalled();
  });

  it('passes the Idempotency-Key through to catalog', async () => {
    const publishTimetable = vi.fn(
      (
        _request: PublishTimetableGrpcRequest,
        _metadata?: unknown,
        _options?: CallOptions,
      ) => of(PUBLISH_RESPONSE),
    );
    const controller = new OperationsController(
      new OperationsService(clientWith({ publishTimetable })),
    );

    await controller.publishTimetable(publishBody(), 'key-1');

    const metadata = publishTimetable.mock.calls[0][1] as {
      get: (key: string) => string[];
    };
    expect(metadata.get('idempotency-key')).toEqual(['key-1']);
  });

  it('passes the Idempotency-Key to the service unchanged', async () => {
    const publishTimetable = vi.fn().mockResolvedValue(PUBLISH_RESULT);
    const controller = controllerWith({ publishTimetable });
    const body = publishBody();

    await controller.publishTimetable(body, 'key-2');

    expect(publishTimetable).toHaveBeenCalledWith(body, 'key-2');
  });

  it('restores the refusal code and details from the gRPC status', async () => {
    const publishTimetable = vi.fn(() =>
      throwError(() => ({
        code: 6, // ALREADY_EXISTS maps to CONFLICT.
        details: JSON.stringify({
          code: ErrorCode.CONFLICT,
          details: [
            {
              field: 'effectiveFrom',
              rejectedValue: '2026-06-20',
              issue: 'overlaps the currently effective timetable version',
              action: 'Choose a date after the active version ends',
            },
          ],
        }),
      })),
    );
    const controller = new OperationsController(
      new OperationsService(clientWith({ publishTimetable })),
    );

    const error = (await controller
      .publishTimetable(publishBody(), 'key-3')
      .catch((caught: unknown) => caught)) as HttpException;

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    const body = error.getResponse() as {
      code: string;
      message: { field: string; issue: string }[];
    };
    expect(body.code).toBe(ErrorCode.CONFLICT);
    expect(body.message[0].field).toBe('effectiveFrom');
    expect(body.message[0].issue).toContain('overlaps');
  });

  it('returns created, changed and withdrawn counts', async () => {
    const publishTimetable = vi.fn(
      (
        _request: PublishTimetableGrpcRequest,
        _metadata?: unknown,
        _options?: CallOptions,
      ) => of(PUBLISH_RESPONSE),
    );
    const controller = new OperationsController(
      new OperationsService(clientWith({ publishTimetable })),
    );

    await expect(
      controller.publishTimetable(publishBody(), 'key-4'),
    ).resolves.toEqual(PUBLISH_RESULT);

    // A genuine zero must survive the wire, not become absent.
    await expect(
      controller.publishTimetable(publishBody(), 'key-4'),
    ).resolves.toHaveProperty('created', 0);
  });

  it('returns created, changed and withdrawn when the service answers them', async () => {
    const publishTimetable = vi.fn().mockResolvedValue(PUBLISH_RESULT);
    const controller = controllerWith({ publishTimetable });

    await expect(
      controller.publishTimetable(publishBody(), 'key-5'),
    ).resolves.toEqual({
      timetableId: 'timetable-2',
      version: 2,
      created: 0,
      changed: 4,
      withdrawn: 1,
    });
  });

  it('rejects a malformed body before the hop', async () => {
    const publishTimetable = vi.fn();
    const controller = controllerWith({ publishTimetable });
    const pipe = createValidationPipe();

    const outOfRangeDay = publishBody();
    outOfRangeDay.runningDays = [9];
    await expect(
      pipe.transform(outOfRangeDay, {
        type: 'body',
        metatype: PublishTimetableDto,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const malformedStation = publishBody();
    malformedStation.stops[0].stationId = 'ramsis';
    await expect(
      pipe.transform(malformedStation, {
        type: 'body',
        metatype: PublishTimetableDto,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(controller).toBeDefined();
    expect(publishTimetable).not.toHaveBeenCalled();
  });

  it('passes an audit query through and returns the page', async () => {
    const page = { entries: [], nextCursor: 'cursor-2' };
    const listAudit = vi.fn().mockResolvedValue(page);
    const controller = controllerWith({ listAudit });
    const query = { trainId: CAIRO, limit: 10 } as ListAuditQueryDto;

    await expect(controller.listAudit(query)).resolves.toBe(page);
    expect(listAudit).toHaveBeenCalledWith(query);
  });
});

describe('the gateway operations module', () => {
  it('registers the controller, both services and the resolved client token', () => {
    const controllers = Reflect.getMetadata('controllers', OperationsModule) as
      | unknown[]
      | undefined;
    const providers = Reflect.getMetadata('providers', OperationsModule) as
      | unknown[]
      | undefined;

    expect(controllers).toContain(OperationsController);
    expect(providers).toContain(OperationsService);
    expect(providers).toContain(OperationsGrpcClientService);
    expect(
      providers?.some(
        (provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          (provider as { provide?: unknown }).provide ===
            OPERATIONS_GRPC_CLIENT,
      ),
    ).toBe(true);
  });
});
