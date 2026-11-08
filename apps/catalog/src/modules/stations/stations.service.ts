import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  jitteredTtlSeconds,
  STATIONS_TTL_JITTER_FRACTION,
  STATIONS_TTL_SECONDS,
} from '../cache/catalog-cache.keys.js';
import { StationsRepository } from './stations.repository.js';
import type { StationCatalogDto } from './stations.types.js';

export const STATIONS_CACHE_KEY = 'catalog:stations:v1';

/**
 * The Station Catalog service (CAT-1).
 *
 * Cache-aside with a 24-hour jittered TTL. Bilingual payload stored in shared
 * Redis cache so English and Arabic requests are served from the same entry
 * without duplication (§2.3 rule 6).
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

    const cached = await this.cache.get<StationCatalogDto>(STATIONS_CACHE_KEY);
    if (cached !== null && cached.governorates) {
      this.cache.getMetrics?.()?.recordHit('stations');
      return cached;
    }

    this.cache.getMetrics?.()?.recordMiss('stations');

    const fresh = await this.repository.findAllActive();
    const ttl = jitteredTtlSeconds(
      STATIONS_TTL_SECONDS,
      STATIONS_TTL_JITTER_FRACTION,
    );
    await this.cache.set(STATIONS_CACHE_KEY, fresh, ttl);

    return fresh;
  }

  async invalidate(): Promise<void> {
    if (this.cache) {
      await this.cache.del(STATIONS_CACHE_KEY);
    }
  }
}
