import { SetMetadata } from '@nestjs/common';
import type { AccessLevel, StaffRole } from '@app/contracts';

export const ACCESS_LEVEL_KEY = 'auth:access-level';
export const STAFF_ROLE_KEY = 'auth:staff-role';
export const RATE_LIMIT_KEY = 'auth:rate-limit';

/**
 * Deny-by-default: a route that declares no level or role is closed.
 * `@Public()` is an explicit declaration, not an absence of one, so the route
 * walk can prove the public surface is exactly BR-01's list.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_LEVEL_KEY, 'public' satisfies AccessLevel);

export const RequireAccess = (
  level: Exclude<AccessLevel, 'public'>,
): MethodDecorator & ClassDecorator => SetMetadata(ACCESS_LEVEL_KEY, level);

/**
 * Staff routes use membership, not rank. A token satisfies the requirement
 * when it carries at least one of the named roles.
 */
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
