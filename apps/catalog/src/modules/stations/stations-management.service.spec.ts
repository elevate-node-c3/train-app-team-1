import { describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import {
  ErrorCode,
  type EventEnvelope,
  type StationDetails,
} from '@app/contracts';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import type { OperationsRequestRepository } from '../operations/operations-request.repository.js';
import type { StationsRepository } from './stations.repository.js';
import type { StationsService } from './stations.service.js';
import { StationsManagementService } from './stations-management.service.js';

const ID = '00000000-0000-4000-8000-000000000021';
const CITY = '00000000-0000-4000-8000-000000000011';
const ACTOR = '00000000-0000-4000-8000-000000000091';
const ORIGINAL: StationDetails = {
  id: ID,
  cityId: CITY,
  governorateId: '00000000-0000-4000-8000-000000000001',
  name: { ar: 'رمسيس', en: 'Ramsis' },
  cityName: { ar: 'القاهرة', en: 'Cairo' },
  governorateName: { ar: 'القاهرة', en: 'Cairo' },
  altSpellings: ['Ramses'],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function harness(options: { failEvent?: boolean; failRecord?: boolean } = {}) {
  const rows = new Map([[ID, structuredClone(ORIGINAL)]]);
  const envelopes: EventEnvelope[] = [];
  const stored = new Map<
    string,
    { idempotencyKey: string; fingerprint: string; responseJson: string }
  >();
  const ctx = { driver: 'test' };
  const calls: string[] = [];
  const repository = {
    findById: vi.fn(async (id: string) =>
      rows.has(id) ? structuredClone(rows.get(id)!) : null,
    ),
    cityExists: vi.fn(async () => true),
    insert: vi.fn(
      async (
        context: unknown,
        id: string,
        request: {
          cityId: string;
          nameAr: string;
          nameEn: string;
          altSpellings?: string[];
          isActive?: boolean;
        },
      ) => {
        expect(context).toBe(ctx);
        rows.set(id, {
          ...structuredClone(ORIGINAL),
          id,
          cityId: request.cityId,
          name: { ar: request.nameAr, en: request.nameEn },
          altSpellings: request.altSpellings ?? [],
          isActive: request.isActive ?? true,
        });
        calls.push('write');
      },
    ),
    update: vi.fn(async (context: unknown, station: StationDetails) => {
      expect(context).toBe(ctx);
      rows.set(station.id, {
        ...structuredClone(station),
        updatedAt: '2026-11-13T00:00:00.000Z',
      });
      calls.push('write');
    }),
  };
  const unitOfWork = {
    withTransaction: vi.fn(
      async (work: (context: typeof ctx) => Promise<unknown>) => {
        const before = structuredClone(rows);
        const beforeStored = structuredClone(stored);
        const envelopeCount = envelopes.length;
        try {
          const result = await work(ctx);
          calls.push('commit');
          return result;
        } catch (error) {
          rows.clear();
          for (const [id, row] of before) rows.set(id, row);
          stored.clear();
          for (const [id, row] of beforeStored) stored.set(id, row);
          envelopes.splice(envelopeCount);
          calls.push('rollback');
          throw error;
        }
      },
    ),
  };
  const requests = {
    find: vi.fn(async (key: string) => stored.get(key) ?? null),
    record: vi.fn(
      async (
        context: unknown,
        row: {
          idempotencyKey: string;
          fingerprint: string;
          responseJson: string;
        },
      ) => {
        expect(context).toBe(ctx);
        if (options.failRecord) throw new Error('record failed');
        stored.set(row.idempotencyKey, row);
      },
    ),
  };
  const outbox = {
    append: vi.fn(async (context: unknown, event: EventEnvelope) => {
      expect(context).toBe(ctx);
      if (options.failEvent) throw new Error('outbox failed');
      envelopes.push(event);
      calls.push('outbox');
    }),
  };
  const stations = {
    invalidate: vi.fn(async () => {
      calls.push('invalidate');
    }),
  };
  const cls = { isActive: () => true, get: () => 'trace-id' };
  const service = new StationsManagementService(
    repository as unknown as StationsRepository,
    stations as unknown as StationsService,
    requests as unknown as OperationsRequestRepository,
    unitOfWork as unknown as UnitOfWorkPort,
    outbox as unknown as OutboxPort,
    cls as unknown as ClsService,
  );
  return {
    service,
    rows,
    envelopes,
    repository,
    unitOfWork,
    requests,
    outbox,
    stations,
    calls,
  };
}

describe('station management and transactional events', () => {
  it('creates a bilingual station and appends its complete event before committing', async () => {
    const h = harness();
    const result = await h.service.create(
      {
        cityId: CITY,
        nameAr: 'محطة جديدة',
        nameEn: 'New Station',
        altSpellings: ['New'],
      },
      'create',
      ACTOR,
    );
    expect(result.station.id).not.toBe(ID);
    expect(h.envelopes).toHaveLength(1);
    expect(h.envelopes[0]).toMatchObject({
      type: 'catalog.station.changed',
      producer: 'catalog',
      correlationId: 'trace-id',
      payload: {
        stationId: result.station.id,
        action: 'created',
        nameAr: 'محطة جديدة',
        nameEn: 'New Station',
        cityId: CITY,
        altSpellings: ['New'],
        isActive: true,
        actorAccountId: ACTOR,
      },
    });
    expect(h.calls).toEqual(['write', 'outbox', 'commit', 'invalidate']);
  });

  it('replays a creation with the same identifier and no additional event', async () => {
    const h = harness();
    const request = { cityId: CITY, nameAr: 'محطة', nameEn: 'Station' };
    const first = await h.service.create(request, 'same', ACTOR);
    expect(await h.service.create(request, 'same', ACTOR)).toEqual(first);
    expect(h.repository.insert).toHaveBeenCalledTimes(1);
    expect(h.envelopes).toHaveLength(1);
  });

  it('refuses an idempotency key reused for another request or operator', async () => {
    const h = harness();
    await h.service.update({ stationId: ID, nameEn: 'Updated' }, 'key', ACTOR);
    await expect(
      h.service.update({ stationId: ID, nameEn: 'Other' }, 'key', ACTOR),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await expect(
      h.service.update(
        { stationId: ID, nameEn: 'Updated' },
        'key',
        'other-actor',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(h.envelopes).toHaveLength(1);
  });

  it('preserves omitted names while clearing aliases and retaining false', async () => {
    const h = harness();
    const result = await h.service.update(
      { stationId: ID, aliases: { values: [] }, isActive: false },
      'patch',
      ACTOR,
    );
    expect(result.station.name).toEqual(ORIGINAL.name);
    expect(result.station.altSpellings).toEqual([]);
    expect(result.station.isActive).toBe(false);
    expect(result.station.createdAt).toBe(ORIGINAL.createdAt);
    expect(h.envelopes[0]).toMatchObject({
      payload: { action: 'deactivated', isActive: false, altSpellings: [] },
    });
  });

  it('publishes a rename snapshot and refreshes only after commit', async () => {
    const h = harness();
    await h.service.update(
      { stationId: ID, nameEn: 'Updated Ramsis' },
      'rename',
      ACTOR,
    );
    expect(h.envelopes[0]).toMatchObject({
      payload: {
        stationId: ID,
        action: 'updated',
        nameEn: 'Updated Ramsis',
        nameAr: ORIGINAL.name.ar,
      },
    });
    expect(h.calls).toEqual(['write', 'outbox', 'commit', 'invalidate']);
  });

  it('soft-deactivates without deleting the row or changing its identifier', async () => {
    const h = harness();
    const result = await h.service.deactivate(ID, 'deactivate', ACTOR);
    expect(result.station.id).toBe(ID);
    expect(h.rows.has(ID)).toBe(true);
    expect(h.rows.get(ID)?.isActive).toBe(false);
    expect(h.envelopes[0]).toMatchObject({
      payload: { stationId: ID, action: 'deactivated' },
    });
  });

  it('does not emit duplicate events for an already-inactive station or unchanged patch', async () => {
    const h = harness();
    await h.service.update(
      { stationId: ID, nameEn: ORIGINAL.name.en },
      'noop',
      ACTOR,
    );
    expect(h.envelopes).toHaveLength(0);
    await h.service.deactivate(ID, 'first', ACTOR);
    await h.service.deactivate(ID, 'second', ACTOR);
    expect(h.envelopes).toHaveLength(1);
    expect(h.repository.update).toHaveBeenCalledTimes(1);
  });

  it.each([{ failEvent: true }, { failRecord: true }])(
    'rolls back the station and event on persistence failure %j',
    async (options) => {
      const h = harness(options);
      await expect(
        h.service.update(
          { stationId: ID, nameEn: 'Rolled Back' },
          'failure',
          ACTOR,
        ),
      ).rejects.toThrow();
      expect(h.rows.get(ID)).toEqual(ORIGINAL);
      expect(h.envelopes).toHaveLength(0);
      expect(h.stations.invalidate).not.toHaveBeenCalled();
      expect(h.calls).toContain('rollback');
    },
  );

  it('refuses unknown station/city and empty/invalid changes with language-free refs', async () => {
    const h = harness();
    await expect(h.service.get('invalid')).rejects.toMatchObject({
      details: [{ field: 'stationId', issueKey: 'ISSUE_MUST_BE_UUID' }],
    });
    await expect(
      h.service.get('00000000-0000-4000-8000-000000000099'),
    ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });
    await expect(
      h.service.update({ stationId: ID }, 'empty', ACTOR),
    ).rejects.toMatchObject({
      details: [{ issueKey: 'ISSUE_STATION_PATCH_EMPTY' }],
    });
    await expect(
      h.service.update({ stationId: ID, nameAr: ' ' }, 'blank', ACTOR),
    ).rejects.toMatchObject({
      details: [{ field: 'nameAr', issueKey: 'ISSUE_STATION_NAME_INVALID' }],
    });
    h.repository.cityExists.mockResolvedValue(false);
    await expect(
      h.service.create(
        { cityId: CITY, nameAr: 'محطة', nameEn: 'Station' },
        'city',
        ACTOR,
      ),
    ).rejects.toMatchObject({
      details: [{ field: 'cityId', issueKey: 'ISSUE_STATION_CITY_NOT_KNOWN' }],
    });
    expect(h.envelopes).toHaveLength(0);
  });
});
