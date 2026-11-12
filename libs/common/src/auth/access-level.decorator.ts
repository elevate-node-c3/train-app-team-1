import { SetMetadata } from '@nestjs/common';
import type { AccessLevel, StaffRole } from '@app/contracts';

export const ACCESS_LEVEL_KEY = 'auth:access-level';
export const STAFF_ROLE_KEY = 'auth:staff-role';
export const RATE_LIMIT_KEY = 'auth:rate-limit';

/**
 * Routes without a declared level or role are closed. Public routes must use
 * `@Public()` explicitly.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_LEVEL_KEY, 'public' satisfies AccessLevel);

export const RequireAccess = (
  level: Exclude<AccessLevel, 'public'>,
): MethodDecorator & ClassDecorator => SetMetadata(ACCESS_LEVEL_KEY, level);

/** Staff roles use membership, not rank; any one of the named roles is enough. */
export const RequireRole = (
  ...roles: StaffRole[]
): MethodDecorator & ClassDecorator => SetMetadata(STAFF_ROLE_KEY, roles);

export interface RateLimitOptions {
  /** Stable bucket name, e.g. 'sign-in'. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export const RateLimit = (
  options: RateLimitOptions,
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_KEY, options);
