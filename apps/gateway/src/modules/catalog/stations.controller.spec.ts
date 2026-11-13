import {
  ACCESS_LEVEL_KEY,
  CALLER_ACCOUNT_ID_HEADER,
  CALLER_ACCOUNT_ID_KEY,
  CALLER_ROLES_KEY,
  RATE_LIMIT_KEY,
  STAFF_ROLE_KEY,
  createValidationPipe,
} from '@app/common';
import {
  ErrorCode,
  type ListStationsResponse,
  type StationResponse,
} from '@app/contracts';
import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { HttpException, HttpStatus, RequestMethod } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import type { ClsService } from 'nestjs-cls';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import { CatalogService } from './catalog.service.js';
import type { CatalogGrpcClient } from './catalog.types.js';
import {
  CreateStationDto,
  StationIdParamDto,
  UpdateStationDto,
} from './dto/station-requests.dto.js';
import { StationsController } from './stations.controller.js';

const RESULT: ListStationsResponse = {
  governorates: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Cairo',
      stations: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'Ramses',
          cityName: 'Cairo',
        },
      ],
    },
  ],
};

function controllerWith(listStations: ReturnType<typeof vi.fn>) {
  return new StationsController({ listStations } as unknown as CatalogService);
}

// Access and route metadata live on the handler, not its controller instance.
const listHandler = Object.getOwnPropertyDescriptor(
  StationsController.prototype,
  'list',
)?.value as object;

describe('the station-picker route', () => {
  it('is GET /stations, not a child of /trips', () => {
    expect(Reflect.getMetadata('path', StationsController)).toBe('stations');
    expect(Reflect.getMetadata('path', listHandler)).toBe('/');
    expect(Reflect.getMetadata('method', listHandler)).toBe(RequestMethod.GET);
  });

  it('is public', () => {
    expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, listHandler)).toBe('public');
  });

  it('uses the stations bucket with 60 calls per 60 seconds', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, listHandler)).toEqual({
      bucket: 'stations',
      limit: 60,
      windowSeconds: 60,
    });
  });

  it('reads language only from Accept-Language and query from the query string', () => {
    expect(
      Reflect.getMetadata(ROUTE_ARGS_METADATA, StationsController, 'list'),
    ).toEqual({
      [`${RouteParamtypes.HEADERS}:0`]: {
        index: 0,
        data: 'accept-language',
        pipes: [],
      },
      [`${RouteParamtypes.QUERY}:1`]: { index: 1, data: 'query', pipes: [] },
    });
  });

  it.each([
    [undefined, 'ar'],
    ['', 'ar'],
    ['*', 'ar'],
    ['fr-FR', 'ar'],
    ['de-DE,zh-CN;q=0.9', 'ar'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['en-US,en;q=0.9', 'en'],
    [' EN-gB,ar;q=0.9 ', 'en'],
    ['ar', 'ar'],
    ['ar-EG', 'ar'],
    ['AR-SA,en;q=0.9', 'ar'],
    ['fr-FR,en-US;q=0.8', 'en'],
  ] as const)(
    'resolves Accept-Language %j to the internal language %s',
    async (acceptLanguage, language) => {
      const listStations = vi.fn().mockResolvedValue(RESULT);

      const response = await controllerWith(listStations).list(
        acceptLanguage,
        '  RaMsEs  ',
      );

      expect(response).toBe(RESULT);
      expect(listStations).toHaveBeenCalledTimes(1);
      expect(listStations).toHaveBeenCalledWith({
        language,
        query: '  RaMsEs  ',
      });
    },
  );

  it.each(['  RaMsEs  ', 'Cairo', 'x'.repeat(101), ''])(
    'forwards string query %j unchanged beside the resolved header language',
    async (query) => {
      const listStations = vi.fn().mockResolvedValue(RESULT);

      await controllerWith(listStations).list('en-GB,en;q=0.9', query);

      expect(listStations).toHaveBeenCalledTimes(1);
      expect(listStations).toHaveBeenCalledWith({ language: 'en', query });
    },
  );

  it('defaults to Arabic and an empty query when the header and query are missing', async () => {
    const listStations = vi.fn().mockResolvedValue(RESULT);

    await controllerWith(listStations).list();

    expect(listStations).toHaveBeenCalledTimes(1);
    expect(listStations).toHaveBeenCalledWith({ language: 'ar', query: '' });
  });

  it.each([undefined, null, 42, true, ['Ramses'], { query: 'Ramses' }])(
    'does not coerce a non-string query: %j',
    async (query) => {
      const listStations = vi.fn().mockResolvedValue(RESULT);

      await controllerWith(listStations).list('en-US,en;q=0.9', query);

      expect(listStations).toHaveBeenCalledTimes(1);
      expect(listStations).toHaveBeenCalledWith({ language: 'en', query: '' });
    },
  );
});

describe('the operator station routes', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const cityId = '22222222-2222-4222-8222-222222222222';
  const create: CreateStationDto = {
    cityId,
    nameAr: 'Ramses AR',
    nameEn: 'Ramses',
    altSpellings: [],
    isActive: false,
  };
  const patch: UpdateStationDto = { altSpellings: [], isActive: false };
  const response: StationResponse = {
    station: {
      id,
      cityId,
      governorateId: '33333333-3333-4333-8333-333333333333',
      name: { en: 'Ramses', ar: 'Ramses AR' },
      cityName: { en: 'Cairo', ar: 'Cairo AR' },
      governorateName: { en: 'Cairo', ar: 'Cairo AR' },
      altSpellings: [],
      isActive: false,
      createdAt: '2026-11-13T01:00:00.000Z',
      updatedAt: '2026-11-13T01:15:00.000Z',
    },
  };
  const routes = [
    { name: 'getStation', path: ':id', method: RequestMethod.GET },
    { name: 'createStation', path: '/', method: RequestMethod.POST },
    { name: 'updateStation', path: ':id', method: RequestMethod.PATCH },
    {
      name: 'deactivateStation',
      path: ':id/deactivate',
      method: RequestMethod.POST,
    },
    { name: 'deleteStation', path: ':id', method: RequestMethod.DELETE },
  ] as const;

  function handler(name: keyof StationsController): object {
    return Object.getOwnPropertyDescriptor(StationsController.prototype, name)
      ?.value as object;
  }

  function controllerWith(service: Partial<CatalogService>) {
    return new StationsController(service as CatalogService);
  }

  function serviceStub() {
    return {
      getStation: vi.fn().mockResolvedValue(response),
      createStation: vi.fn().mockResolvedValue(response),
      updateStation: vi.fn().mockResolvedValue(response),
      deactivateStation: vi.fn().mockResolvedValue(response),
    };
  }

  const mutations = [
    {
      name: 'createStation',
      invoke: (controller: StationsController, key?: string) =>
        controller.createStation(create, key),
      service: 'createStation',
      args: [create],
    },
    {
      name: 'updateStation',
      invoke: (controller: StationsController, key?: string) =>
        controller.updateStation({ id }, patch, key),
      service: 'updateStation',
      args: [id, patch],
    },
    {
      name: 'deactivateStation',
      invoke: (controller: StationsController, key?: string) =>
        controller.deactivateStation({ id }, key),
      service: 'deactivateStation',
      args: [id],
    },
    {
      name: 'deleteStation',
      invoke: (controller: StationsController, key?: string) =>
        controller.deleteStation({ id }, key),
      service: 'deactivateStation',
      args: [id],
    },
  ] as const;

  it.each(routes)(
    'declares $name as $method stations/$path and requires the operator role',
    ({ name, path, method }) => {
      const route = handler(name);
      expect(Reflect.getMetadata('path', route)).toBe(path);
      expect(Reflect.getMetadata('method', route)).toBe(method);
      expect(Reflect.getMetadata(STAFF_ROLE_KEY, route)).toEqual(['operator']);
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, route)).not.toBe('public');
      expect(
        Reflect.getMetadata(ACCESS_LEVEL_KEY, StationsController),
      ).toBeUndefined();
    },
  );

  it('returns 201 for create and 200 for deactivation', () => {
    expect(Reflect.getMetadata('__httpCode__', handler('createStation'))).toBe(
      HttpStatus.CREATED,
    );
    expect(
      Reflect.getMetadata('__httpCode__', handler('deactivateStation')),
    ).toBe(HttpStatus.OK);
  });

  it.each(routes)(
    'binds $name to whole DTO params/body and the idempotency header, without an English UUID pipe',
    ({ name }) => {
      const args: Record<string, unknown> = {};
      if (name !== 'createStation') {
        args[`${RouteParamtypes.PARAM}:0`] = {
          index: 0,
          data: undefined,
          pipes: [],
        };
      }
      if (name === 'createStation' || name === 'updateStation') {
        const index = name === 'createStation' ? 0 : 1;
        args[`${RouteParamtypes.BODY}:${index}`] = {
          index,
          data: undefined,
          pipes: [],
        };
      }
      if (name !== 'getStation') {
        const index = name === 'updateStation' ? 2 : 1;
        args[`${RouteParamtypes.HEADERS}:${index}`] = {
          index,
          data: 'idempotency-key',
          pipes: [],
        };
      }
      expect(
        Reflect.getMetadata(ROUTE_ARGS_METADATA, StationsController, name),
      ).toEqual(args);
    },
  );

  it('returns the full inactive detail snapshot by path ID', async () => {
    const service = serviceStub();
    await expect(controllerWith(service).getStation({ id })).resolves.toBe(
      response,
    );
    expect(service.getStation).toHaveBeenCalledWith(id);
  });

  it.each(mutations)(
    '$name forwards the body/path and trimmed idempotency key',
    async ({ invoke, service: method, args }) => {
      const service = serviceStub();
      await expect(
        invoke(controllerWith(service), '  station-key  '),
      ).resolves.toBe(response);
      expect(service[method]).toHaveBeenCalledTimes(1);
      expect(service[method]).toHaveBeenCalledWith(...args, 'station-key');
    },
  );

  it.each(mutations)(
    '$name refuses missing and blank idempotency keys before the hop',
    async ({ invoke, service: method }) => {
      for (const key of [undefined, '', ' \t ']) {
        const service = serviceStub();
        const error = await invoke(controllerWith(service), key).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(HttpException);
        const exception = error as HttpException;
        expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(exception.getResponse()).toEqual({
          code: ErrorCode.VALIDATION_ERROR,
          message: [
            {
              field: 'Idempotency-Key',
              rejectedValue: key,
              issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
              actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
            },
          ],
        });
        expect(service[method]).not.toHaveBeenCalled();
      }
    },
  );

  it('aliases DELETE to the exact same soft-deactivation command and response', async () => {
    const service = serviceStub();
    const controller = controllerWith(service);

    await expect(
      controller.deactivateStation({ id }, 'same-key'),
    ).resolves.toBe(response);
    await expect(controller.deleteStation({ id }, 'same-key')).resolves.toBe(
      response,
    );

    expect(service.deactivateStation.mock.calls).toEqual([
      [id, 'same-key'],
      [id, 'same-key'],
    ]);
    expect(service).not.toHaveProperty('deleteStation');
  });

  it.each([
    'getStation',
    'updateStation',
    'deactivateStation',
    'deleteStation',
  ] as const)(
    '%s rejects a malformed path ID through the shared native pipe before forwarding',
    async (name) => {
      const service = serviceStub();
      const controller = controllerWith(service);
      const invoke = {
        getStation: (params: StationIdParamDto) =>
          controller.getStation(params),
        updateStation: (params: StationIdParamDto) =>
          controller.updateStation(params, patch, 'key'),
        deactivateStation: (params: StationIdParamDto) =>
          controller.deactivateStation(params, 'key'),
        deleteStation: (params: StationIdParamDto) =>
          controller.deleteStation(params, 'key'),
      };

      await expect(
        createValidationPipe()
          .transform(
            { id: 'ramses' },
            {
              type: 'param',
              metatype: StationIdParamDto,
            },
          )
          .then(invoke[name]),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: {
          message: [
            {
              field: 'id',
              rejectedValue: 'ramses',
              issueKey: 'ISSUE_MUST_BE_UUID',
            },
          ],
        },
      });
      for (const method of Object.values(service))
        expect(method).not.toHaveBeenCalled();
    },
  );

  it('rejects a null PATCH name through the shared native pipe before forwarding', async () => {
    const service = serviceStub();
    const controller = controllerWith(service);
    await expect(
      createValidationPipe()
        .transform(
          { nameEn: null },
          {
            type: 'body',
            metatype: UpdateStationDto,
          },
        )
        .then((body: UpdateStationDto) =>
          controller.updateStation({ id }, body, 'key'),
        ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(service.updateStation).not.toHaveBeenCalled();
  });

  it('carries the actual caller and idempotency keys through controller, service and shared gRPC client', async () => {
    const rpc = vi.fn(
      (_data: unknown, _metadata?: unknown, _options?: CallOptions) =>
        of(response),
    );
    const values: Record<string, unknown> = {
      [CALLER_ACCOUNT_ID_KEY]: 'actual-operator-id',
      [CALLER_ROLES_KEY]: ['operator'],
    };
    const cls = {
      get: (key: string) => values[key],
      set: () => undefined,
    } as unknown as ClsService;
    const client = new CatalogGrpcClientService(
      {
        createStation: rpc,
        updateStation: rpc,
        deactivateStation: rpc,
      } as unknown as CatalogGrpcClient,
      cls,
    );
    const controller = new StationsController(new CatalogService(client));
    const createBody = await createValidationPipe().transform(
      { ...create, nameEn: '  Ramses  ' },
      { type: 'body', metatype: CreateStationDto },
    );
    const patchBody = await createValidationPipe().transform(patch, {
      type: 'body',
      metatype: UpdateStationDto,
    });

    await expect(
      controller.createStation(createBody, '  create-1  '),
    ).resolves.toBe(response);
    await expect(
      controller.updateStation({ id }, patchBody, '  patch-1  '),
    ).resolves.toBe(response);
    await expect(
      controller.deleteStation({ id }, '  delete-1  '),
    ).resolves.toBe(response);

    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      create,
      { stationId: id, aliases: { values: [] }, isActive: false },
      { stationId: id },
    ]);
    for (const [index, key] of ['create-1', 'patch-1', 'delete-1'].entries()) {
      const metadata = rpc.mock.calls[index][1] as Metadata;
      expect(metadata.get(CALLER_ACCOUNT_ID_HEADER)).toEqual([
        'actual-operator-id',
      ]);
      expect(metadata.get('idempotency-key')).toEqual([key]);
    }
  });
});
