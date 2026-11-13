import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import {
  ErrorCode,
  type CreateStationRequest,
  type StationDetails,
  type StationResponse,
  type UpdateStationRequest,
  type StationChangedPayloadV1,
} from '@app/contracts';
import { isUuidShape } from '@app/common/validation/uuid.js';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
  type TransactionContext,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import {
  fingerprintOf,
  OperationsRequestRepository,
} from '../operations/operations-request.repository.js';
import { CatalogSearchError } from '../trips/catalog-search-error.js';
import { StationsRepository } from './stations.repository.js';
import { StationsService } from './stations.service.js';
import { buildStationChanged } from './station-events.factory.js';

@Injectable()
export class StationsManagementService {
  constructor(
    private readonly repository: StationsRepository,
    private readonly stations: StationsService,
    private readonly requests: OperationsRequestRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    private readonly cls: ClsService,
  ) {}

  async get(stationId: string): Promise<StationResponse> {
    this.requireStationId(stationId);
    return { station: await this.requireStation(stationId) };
  }

  async create(
    request: CreateStationRequest,
    key: string,
    actor: string,
  ): Promise<StationResponse> {
    this.validateNames(request, true);
    return this.mutate('station.create', request, key, actor, async (ctx) => {
      await this.requireCity(ctx, request.cityId);
      const stationId = randomUUID();
      await this.repository.insert(ctx, stationId, request);
      const station = await this.requireStation(stationId, ctx);
      await this.publish(ctx, station, 'created', actor);
      return { station };
    });
  }

  async update(
    request: UpdateStationRequest,
    key: string,
    actor: string,
  ): Promise<StationResponse> {
    this.requireStationId(request.stationId);
    if (
      request.cityId === undefined &&
      request.nameAr === undefined &&
      request.nameEn === undefined &&
      request.aliases === undefined &&
      request.isActive === undefined
    ) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'payload',
          rejectedValue: request,
          issueKey: 'ISSUE_STATION_PATCH_EMPTY',
          actionKey: 'ACTION_SEND_STATION_CHANGES',
        },
      ]);
    }
    this.validateNames(request);
    return this.mutate('station.update', request, key, actor, async (ctx) => {
      const before = await this.requireStation(request.stationId, ctx);
      if (request.cityId !== undefined)
        await this.requireCity(ctx, request.cityId);
      const next: StationDetails = {
        ...before,
        cityId: request.cityId ?? before.cityId,
        name: {
          ar: request.nameAr ?? before.name.ar,
          en: request.nameEn ?? before.name.en,
        },
        altSpellings: request.aliases?.values ?? before.altSpellings,
        isActive: request.isActive ?? before.isActive,
      };
      if (
        next.cityId === before.cityId &&
        next.name.ar === before.name.ar &&
        next.name.en === before.name.en &&
        next.isActive === before.isActive &&
        JSON.stringify(next.altSpellings) ===
          JSON.stringify(before.altSpellings)
      )
        return { station: before };
      await this.repository.update(ctx, next);
      const station = await this.requireStation(before.id, ctx);
      await this.publish(
        ctx,
        station,
        before.isActive && !station.isActive ? 'deactivated' : 'updated',
        actor,
      );
      return { station };
    });
  }

  async deactivate(
    stationId: string,
    key: string,
    actor: string,
  ): Promise<StationResponse> {
    this.requireStationId(stationId);
    return this.mutate(
      'station.deactivate',
      { stationId },
      key,
      actor,
      async (ctx) => {
        const before = await this.requireStation(stationId, ctx);
        if (!before.isActive) return { station: before };
        // IDs and timetable/trip references are retained, including on DELETE.
        await this.repository.update(ctx, { ...before, isActive: false });
        const station = await this.requireStation(stationId, ctx);
        await this.publish(ctx, station, 'deactivated', actor);
        return { station };
      },
    );
  }

  private async mutate(
    operation: string,
    request: unknown,
    key: string,
    actor: string,
    work: (ctx: TransactionContext) => Promise<StationResponse>,
  ): Promise<StationResponse> {
    if (!actor)
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'callerAccountId',
          rejectedValue: actor,
          issueKey: 'ISSUE_CALLER_ACCOUNT_MISSING',
          actionKey: 'ACTION_SIGN_IN_AND_RETRY',
        },
      ]);
    if (!key?.trim())
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'Idempotency-Key',
          rejectedValue: key,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REQUIRED',
          actionKey: 'ACTION_SEND_IDEMPOTENCY_KEY',
        },
      ]);
    const fingerprint = fingerprintOf({ operation, request, actor });
    const replay = await this.replay(key, fingerprint);
    if (replay) return replay;
    try {
      const result = await this.unitOfWork.withTransaction(async (ctx) => {
        const response = await work(ctx);
        await this.requests.record(ctx, {
          idempotencyKey: key,
          fingerprint,
          responseJson: JSON.stringify(response),
        });
        return response;
      });
      await this.stations.invalidate();
      return result;
    } catch (error: unknown) {
      const candidate = error as {
        code?: string;
        driverError?: { code?: string };
      } | null;
      if (
        candidate?.code === '23505' ||
        candidate?.driverError?.code === '23505'
      ) {
        const raced = await this.replay(key, fingerprint);
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async replay(
    key: string,
    fingerprint: string,
  ): Promise<StationResponse | null> {
    const stored = await this.requests.find(key);
    if (!stored) return null;
    if (stored.fingerprint !== fingerprint)
      throw new CatalogSearchError(ErrorCode.CONFLICT, [
        {
          field: 'Idempotency-Key',
          rejectedValue: key,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ]);
    return JSON.parse(stored.responseJson) as StationResponse;
  }

  private requireStationId(stationId: string): void {
    if (!isUuidShape(stationId))
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'stationId',
          rejectedValue: stationId,
          issueKey: 'ISSUE_MUST_BE_UUID',
        },
      ]);
  }

  private async requireStation(
    stationId: string,
    ctx?: TransactionContext,
  ): Promise<StationDetails> {
    const station = await this.repository.findById(stationId, ctx);
    if (!station)
      throw new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, [
        {
          field: 'stationId',
          rejectedValue: stationId,
          issueKey: 'ISSUE_STATION_NOT_FOUND',
          actionKey: 'ACTION_REFRESH_STATIONS',
        },
      ]);
    return station;
  }

  private async requireCity(
    ctx: TransactionContext,
    cityId: string,
  ): Promise<void> {
    if (
      !isUuidShape(cityId) ||
      !(await this.repository.cityExists(ctx, cityId))
    )
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'cityId',
          rejectedValue: cityId,
          issueKey: 'ISSUE_STATION_CITY_NOT_KNOWN',
          actionKey: 'ACTION_PICK_STATION_CITY',
        },
      ]);
  }

  private validateNames(
    request: {
      nameAr?: string;
      nameEn?: string;
      altSpellings?: string[];
      aliases?: { values: string[] };
    },
    required = false,
  ): void {
    for (const field of ['nameAr', 'nameEn'] as const) {
      const value = request[field];
      if (
        (required || value !== undefined) &&
        (typeof value !== 'string' || !value.trim() || value.length > 120)
      )
        throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
          {
            field,
            rejectedValue: value,
            issueKey: 'ISSUE_STATION_NAME_INVALID',
            actionKey: 'ACTION_SET_BILINGUAL_STATION_NAME',
          },
        ]);
    }
    const aliases = request.altSpellings ?? request.aliases?.values;
    if (
      aliases !== undefined &&
      (!Array.isArray(aliases) ||
        aliases.length > 100 ||
        aliases.some(
          (alias) =>
            typeof alias !== 'string' || !alias.trim() || alias.length > 120,
        ))
    )
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'altSpellings',
          rejectedValue: aliases,
          issueKey: 'ISSUE_STATION_ALIASES_INVALID',
          actionKey: 'ACTION_SET_STATION_ALIASES',
        },
      ]);
  }

  private async publish(
    ctx: TransactionContext,
    station: StationDetails,
    action: StationChangedPayloadV1['action'],
    actor: string,
  ): Promise<void> {
    const correlationId =
      (this.cls.isActive()
        ? this.cls.get<string>(CORRELATION_ID_KEY)
        : undefined) || randomUUID();
    await this.outbox.append(
      ctx,
      buildStationChanged({
        eventId: randomUUID(),
        correlationId,
        occurredAt: new Date(),
        payload: {
          stationId: station.id,
          action,
          nameAr: station.name.ar,
          nameEn: station.name.en,
          cityId: station.cityId,
          governorateId: station.governorateId,
          cityName: station.cityName,
          governorateName: station.governorateName,
          altSpellings: station.altSpellings,
          isActive: station.isActive,
          actorAccountId: actor,
        },
      }),
    );
  }
}
