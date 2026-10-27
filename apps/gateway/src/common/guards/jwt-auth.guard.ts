import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { Request } from 'express';
import {
  ACCESS_LEVEL_RANK,
  ErrorCode,
  type AccessLevel,
  type StaffRole,
} from '@app/contracts';
import {
  ACCESS_LEVEL_KEY,
  AccessTokenVerificationError,
  CALLER_ACCESS_EXPIRES_AT_KEY,
  CALLER_ACCESS_LEVEL_KEY,
  CALLER_ACCOUNT_ID_KEY,
  CALLER_BOOKABLE_KEY,
  CALLER_JTI_KEY,
  CALLER_ROLES_KEY,
  CALLER_SESSION_ID_KEY,
  STAFF_ROLE_KEY,
  type AuthenticatedCaller,
} from '@app/common';
import { TokenVerifierService } from '../security/token-verifier.service.js';
import { RevocationStore } from '../security/stores/revocation.store.js';

/**
 * Deny by default. A route with no `@Public()`, `@RequireAccess()` or
 * `@RequireRole()` metadata is closed, so a new controller cannot become
 * anonymous by forgetting a decorator. Health and service-info routes opt in
 * explicitly.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly verifier: TokenVerifierService,
    private readonly revocations: RevocationStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredLevel = this.reflector.getAllAndOverride<AccessLevel>(
      ACCESS_LEVEL_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredRoles =
      this.reflector.getAllAndOverride<StaffRole[]>(STAFF_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredLevel === 'public' && requiredRoles.length === 0) return true;
    if (!requiredLevel && requiredRoles.length === 0) {
      throw this.unauthorized(ErrorCode.UNAUTHORIZED);
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedCaller }>();
    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw this.unauthorized(ErrorCode.UNAUTHORIZED);
    }

    let claims;
    try {
      claims = await this.verifier.verify(token);
    } catch (error: unknown) {
      if (error instanceof AccessTokenVerificationError) {
        throw this.unauthorized(
          error.reason === 'expired'
            ? ErrorCode.TOKEN_EXPIRED
            : ErrorCode.TOKEN_INVALID,
        );
      }
      throw this.unauthorized(ErrorCode.TOKEN_INVALID);
    }

    if (await this.revocations.isRevoked(claims)) {
      throw this.unauthorized(ErrorCode.TOKEN_REVOKED);
    }

    const caller: AuthenticatedCaller = {
      accountId: claims.sub,
      sessionId: claims.sid,
      jti: claims.jti,
      level: claims.lvl,
      roles: [...claims.roles],
      bookable: claims.bkbl,
      expiresAt: claims.exp,
    };

    request.user = caller;
    this.cls.set(CALLER_ACCOUNT_ID_KEY, caller.accountId);
    this.cls.set(CALLER_SESSION_ID_KEY, caller.sessionId);
    this.cls.set(CALLER_JTI_KEY, caller.jti);
    this.cls.set(CALLER_ROLES_KEY, caller.roles);
    this.cls.set(CALLER_BOOKABLE_KEY, caller.bookable);
    this.cls.set(CALLER_ACCESS_LEVEL_KEY, caller.level);
    this.cls.set(CALLER_ACCESS_EXPIRES_AT_KEY, caller.expiresAt);

    if (
      requiredLevel &&
      requiredLevel !== 'public' &&
      ACCESS_LEVEL_RANK[caller.level] < ACCESS_LEVEL_RANK[requiredLevel]
    ) {
      throw new HttpException(
        {
          code:
            requiredLevel === 'bookable'
              ? ErrorCode.PROFILE_INCOMPLETE
              : ErrorCode.FORBIDDEN,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    if (
      requiredRoles.length > 0 &&
      !requiredRoles.some((role) => caller.roles.includes(role))
    ) {
      throw new HttpException(
        { code: ErrorCode.FORBIDDEN },
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  private unauthorized(code: ErrorCode): HttpException {
    return new HttpException({ code }, HttpStatus.UNAUTHORIZED);
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !value || rest.length > 0) {
    return null;
  }
  return value;
}
