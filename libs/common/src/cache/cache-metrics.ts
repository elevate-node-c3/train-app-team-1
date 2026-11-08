import { Injectable } from '@nestjs/common';

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
 * In-memory thread-safe hit and miss metrics registry per key family (§2.3 rule 8).
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

  recordHit(family: CacheFamily): void {
    this.hits[family] = (this.hits[family] ?? 0) + 1;
  }

  recordMiss(family: CacheFamily): void {
    this.misses[family] = (this.misses[family] ?? 0) + 1;
  }

  getFamilyStats(family: CacheFamily): FamilyStats {
    const hits = this.hits[family] ?? 0;
    const misses = this.misses[family] ?? 0;
    const total = hits + misses;
    const hitRate = total === 0 ? 0 : hits / total;
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
    const overallHitRate = overallTotal === 0 ? 0 : totalHits / overallTotal;

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

  reset(): void {
    for (const key of Object.keys(this.hits) as CacheFamily[]) {
      this.hits[key] = 0;
      this.misses[key] = 0;
    }
  }
}
