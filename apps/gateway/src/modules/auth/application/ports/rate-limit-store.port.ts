export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export interface RateLimitHit {
  count: number;
  /** True when the shared Redis window could not be used. */
  degraded: boolean;
}

export interface RateLimitStorePort {
  increment(key: string, windowSeconds: number): Promise<RateLimitHit>;
}
