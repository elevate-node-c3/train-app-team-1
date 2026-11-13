import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import { ErrorCode, type ListStationsResponse } from '@app/contracts';
import { MAX_QUERY_LENGTH } from '../../config/station-search-settings.js';
import {
  jitteredTtlSeconds,
  STATIONS_TTL_JITTER_FRACTION,
  STATIONS_TTL_SECONDS,
} from '../cache/catalog-cache.keys.js';
import { StationsRepository } from './stations.repository.js';
import type { StationCatalogDto } from './stations.types.js';
import { buildStationMatcher } from './station-matcher.js';
import { CatalogSearchError } from '../trips/catalog-search-error.js';

/** Never expires, and holds one integer: the generation reads are allowed to see. */
export const STATIONS_GENERATION_KEY = 'catalog:stations:generation';

/** The generation a read resolves before it looks anything up. */
export function stationsCacheKey(generation: number): string {
  return `catalog:stations:v1:g${generation}`;
}

/**
 * The Station Catalog service (CAT-1).
 *
 * Cache-aside with a 24-hour jittered TTL. Bilingual payload stored in shared
 * Redis cache so English and Arabic requests are served from the same entry
 * without duplication (§2.3 rule 6).
 *
 * Reads are generational, not deleted (§2.3 rule 5, §6.3). A delete cannot win
 * the interleaving TA-19 names: a rebuild that read Postgres before a station
 * changed would write its stale list back after the delete and hold it for the
 * full 24 hours. Bumping the generation instead means that write lands on a key
 * no later read resolves. The counter itself is the one key here that must not
 * be evicted; `invalidate` also drops the superseded entry so an evicted
 * counter cannot resurrect it.
 */
@Injectable()
export class StationsService {
  constructor(
    private readonly repository: StationsRepository,
    @Optional() private readonly cache?: CacheAsideService,
  ) {}

  async listStations(): Promise<StationCatalogDto> {
    if (!this.cache) {
      return this.repository.findAllActive();
    }

    return this.cache.getOrRebuild(
      stationsCacheKey(await this.generation()),
      'stations',
      () => this.repository.findAllActive(),
      jitteredTtlSeconds(STATIONS_TTL_SECONDS, STATIONS_TTL_JITTER_FRACTION),
      { isValid: isStationCatalog },
    );
  }

  async listStationGroups(
    language: unknown,
    query = '',
  ): Promise<ListStationsResponse> {
    if (language !== 'ar' && language !== 'en') {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'language',
          rejectedValue: language,
          issueKey: 'ISSUE_STATION_LANGUAGE_INVALID',
          actionKey: 'ACTION_SET_STATION_LANGUAGE',
        },
      ]);
    }

    if (query.length > MAX_QUERY_LENGTH) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'query',
          rejectedValue: query,
          issueKey: 'ISSUE_STATION_QUERY_TOO_LONG',
          actionKey: 'ACTION_SHORTEN_STATION_QUERY',
          params: { maxLength: String(MAX_QUERY_LENGTH) },
        },
      ]);
    }

    const catalog = await this.listStations();
    const matches = buildStationMatcher(query);
    return {
      governorates: [...catalog.governorates]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .flatMap((governorate) => {
          const stations = governorate.cities
            .flatMap((city) =>
              city.stations
                .filter((station) =>
                  matches({
                    nameAr: station.name.ar,
                    nameEn: station.name.en,
                    altSpellings: station.altSpellings,
                    cityNameAr: city.name.ar,
                    cityNameEn: city.name.en,
                    governorateNameAr: governorate.name.ar,
                    governorateNameEn: governorate.name.en,
                  }),
                )
                .map((station) => ({ station, cityName: city.name })),
            )
            .sort(
              (a, b) =>
                a.station.name.en.localeCompare(b.station.name.en, 'en') ||
                a.station.id.localeCompare(b.station.id),
            );
          if (stations.length === 0) return [];
          return [
            {
              id: governorate.id,
              name: governorate.name[language],
              stations: stations.map(({ station, cityName }) => ({
                id: station.id,
                name: station.name[language],
                cityName: cityName[language],
              })),
            },
          ];
        }),
    };
  }

  async invalidate(): Promise<void> {
    if (!this.cache) return;

    const superseded = await this.generation();
    const next = await this.cache.increment(STATIONS_GENERATION_KEY);
    // INCR starts an absent counter at 1, which is the unversioned default, so
    // the first invalidation has to move it 1 -> 2 to mean anything.
    if (next === 1) await this.cache.increment(STATIONS_GENERATION_KEY);
    await this.cache.del(stationsCacheKey(superseded));
  }

  /** 1 until something invalidates, and 1 again if Redis cannot answer. */
  private async generation(): Promise<number> {
    const stored = await this.cache!.get<unknown>(STATIONS_GENERATION_KEY);
    return typeof stored === 'number' && Number.isInteger(stored) && stored > 0
      ? stored
      : 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isName(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.ar === 'string' &&
    typeof value.en === 'string'
  );
}

function isStationCatalog(value: unknown): value is StationCatalogDto {
  return (
    isRecord(value) &&
    Array.isArray(value.governorates) &&
    value.governorates.every(
      (governorate: unknown) =>
        isRecord(governorate) &&
        typeof governorate.id === 'string' &&
        isName(governorate.name) &&
        typeof governorate.sortOrder === 'number' &&
        Number.isFinite(governorate.sortOrder) &&
        Array.isArray(governorate.cities) &&
        governorate.cities.every(
          (city: unknown) =>
            isRecord(city) &&
            typeof city.id === 'string' &&
            isName(city.name) &&
            Array.isArray(city.stations) &&
            city.stations.every(
              (station: unknown) =>
                isRecord(station) &&
                typeof station.id === 'string' &&
                isName(station.name) &&
                Array.isArray(station.altSpellings) &&
                station.altSpellings.every(
                  (alias: unknown) => typeof alias === 'string',
                ),
            ),
        ),
    )
  );
}
