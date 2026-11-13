import { Injectable, Logger } from '@nestjs/common';
import { RedisClientService } from '@app/common';

export function routeVersionKey(
  originStationId: string,
  destinationStationId: string,
): string {
  return `catalog:route-version:v1:${originStationId}:${destinationStationId}`;
}

/**
 * A route version invalidates all its search keys in O(1), without KEYS or SCAN.
 */
@Injectable()
export class RouteVersionService {
  private readonly logger = new Logger(RouteVersionService.name);
  private readonly fallbackVersions = new Map<string, number>();

  constructor(private readonly redis: RedisClientService) {}

  async getRouteVersion(
    originStationId: string,
    destinationStationId: string,
  ): Promise<number> {
    const key = routeVersionKey(originStationId, destinationStationId);
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;

    if (!client) {
      return this.fallbackVersions.get(key) ?? 1;
    }

    try {
      const raw = await client.get(key);
      if (raw === null) return 1;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? 1 : parsed;
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to read route version for ${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.fallbackVersions.get(key) ?? 1;
    }
  }

  async incrementRouteVersion(
    originStationId: string,
    destinationStationId: string,
  ): Promise<number> {
    const key = routeVersionKey(originStationId, destinationStationId);
    const client = this.redis.isAvailable() ? this.redis.getClient() : null;

    const currentFallback = this.fallbackVersions.get(key) ?? 1;
    const nextFallback = currentFallback + 1;
    this.fallbackVersions.set(key, nextFallback);

    if (!client) {
      return nextFallback;
    }

    try {
      let newVersion = await client.incr(key);
      // INCR starts missing keys at 1; the first invalidation must move 1 to 2.
      if (newVersion === 1) {
        newVersion = await client.incr(key);
      }
      this.fallbackVersions.set(key, newVersion);
      return newVersion;
    } catch (err: unknown) {
      this.logger.debug(
        `Failed to increment route version for ${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return nextFallback;
    }
  }
}
