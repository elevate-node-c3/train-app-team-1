import { Injectable, Optional } from '@nestjs/common';
import { RedisClientService } from './redis-client.service.js';

export type CacheFamily = 'search' | 'trip-stops' | 'stations' | 'availability';

export interface FamilyStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
}

export interface MetricsSnapshot {
  search: FamilyStats;
  'trip-stops': FamilyStats;
  stations: FamilyStats;
  availability: FamilyStats;
  overall: FamilyStats;
}

/**
 * Thread-safe local hit/miss counts per key family, with Redis aggregation
 * across instances when available.
 */
@Injectable()
export class CacheMetrics {
  private readonly hits: Record<CacheFamily, number> = {
    search: 0,
    'trip-stops': 0,
    stations: 0,
    availability: 0,
  };

  private readonly misses: Record<CacheFamily, number> = {
    search: 0,
    'trip-stops': 0,
    stations: 0,
    availability: 0,
  };

  constructor(@Optional() private readonly redis?: RedisClientService) {}

  recordHit(family: CacheFamily): void {
    this.hits[family] = (this.hits[family] ?? 0) + 1;
    if (this.redis?.isAvailable()) {
      this.redis.getClient()?.hincrby('catalog:metrics:v1:hits', family, 1).catch(() => {});
    }
  }

  recordMiss(family: CacheFamily): void {
    this.misses[family] = (this.misses[family] ?? 0) + 1;
    if (this.redis?.isAvailable()) {
      this.redis.getClient()?.hincrby('catalog:metrics:v1:misses', family, 1).catch(() => {});
    }
  }

  getFamilyStats(family: CacheFamily): FamilyStats {
    const hits = this.hits[family] ?? 0;
    const misses = this.misses[family] ?? 0;
    const total = hits + misses;
    const hitRate = total === 0 ? 0 : Math.round((hits / total) * 10000) / 10000;
    return { hits, misses, total, hitRate };
  }

  getSnapshot(): MetricsSnapshot {
    const families: CacheFamily[] = ['search', 'trip-stops', 'stations', 'availability'];
    let totalHits = 0;
    let totalMisses = 0;

    const result: Partial<MetricsSnapshot> = {};

    for (const family of families) {
      const stats = this.getFamilyStats(family);
      result[family] = stats;
      totalHits += stats.hits;
      totalMisses += stats.misses;
    }

    const overallTotal = totalHits + totalMisses;
    const overallHitRate =
      overallTotal === 0 ? 0 : Math.round((totalHits / overallTotal) * 10000) / 10000;

    return {
      search: result.search!,
      'trip-stops': result['trip-stops']!,
      stations: result.stations!,
      availability: result.availability!,
      overall: {
        hits: totalHits,
        misses: totalMisses,
        total: overallTotal,
        hitRate: overallHitRate,
      },
    };
  }

  async getSnapshotAsync(): Promise<MetricsSnapshot> {
    if (this.redis?.isAvailable()) {
      try {
        const client = this.redis.getClient();
        if (client) {
          const [hitsRaw, missesRaw] = await Promise.all([
            client.hgetall('catalog:metrics:v1:hits'),
            client.hgetall('catalog:metrics:v1:misses'),
          ]);
          if (
            hitsRaw &&
            missesRaw &&
            (Object.keys(hitsRaw).length > 0 || Object.keys(missesRaw).length > 0)
          ) {
            const families: CacheFamily[] = ['search', 'trip-stops', 'stations', 'availability'];
            let totalHits = 0;
            let totalMisses = 0;
            const result: Partial<MetricsSnapshot> = {};

            for (const fam of families) {
              const h = parseInt(hitsRaw[fam] || '0', 10) || 0;
              const m = parseInt(missesRaw[fam] || '0', 10) || 0;
              const tot = h + m;
              const rate = tot === 0 ? 0 : Math.round((h / tot) * 10000) / 10000;
              result[fam] = { hits: h, misses: m, total: tot, hitRate: rate };
              totalHits += h;
              totalMisses += m;
            }

            const overallTotal = totalHits + totalMisses;
            const overallRate =
              overallTotal === 0 ? 0 : Math.round((totalHits / overallTotal) * 10000) / 10000;

            return {
              search: result.search!,
              'trip-stops': result['trip-stops']!,
              stations: result.stations!,
              availability: result.availability!,
              overall: {
                hits: totalHits,
                misses: totalMisses,
                total: overallTotal,
                hitRate: overallRate,
              },
            };
          }
        }
      } catch {
        // Redis failures fall back to local counts.
      }
    }
    return this.getSnapshot();
  }

  reset(): void {
    for (const key of Object.keys(this.hits) as CacheFamily[]) {
      this.hits[key] = 0;
      this.misses[key] = 0;
    }
    if (this.redis?.isAvailable()) {
      this.redis
        .getClient()
        ?.del('catalog:metrics:v1:hits', 'catalog:metrics:v1:misses')
        .catch(() => {});
    }
  }
}
