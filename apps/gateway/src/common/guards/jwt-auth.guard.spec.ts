import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_LEVEL_RANK,
  ErrorCode,
  type AccessLevel,
  type AccessTokenClaims,
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
} from '@app/common';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { RevocationStore } from '../security/stores/revocation.store.js';

const CLAIMS: AccessTokenClaims = {
  sub: 'account-1',
  lvl: 'traveller',
  roles: ['operator'],
  sid: 'session-1',
  jti: 'jti-1',
  bkbl: false,
  iss: 'train-app-identity',
  aud: 'train-app-gateway',
  iat: 1_760_000_000,
  exp: 1_760_000_900,
};

interface Harness {
  guard: JwtAuthGuard;
  request: { headers: Record<string, string>; user?: unknown };
  cls: Map<string, unknown>;
  verify: ReturnType<typeof vi.fn>;
  isRevoked: ReturnType<typeof vi.fn>;
}

function harness(level?: AccessLevel, roles?: StaffRole[]): Harness {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: {},
  };
  const cls = new Map<string, unknown>();
  const verify = vi.fn();
  const isRevoked = vi.fn();
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === ACCESS_LEVEL_KEY) return level;
      if (key === STAFF_ROLE_KEY) return roles;
      return undefined;
    }),
  } as unknown as Reflector;
  const clsService = {
    get: (key: string) => cls.get(key),
    set: (key: string, value: unknown) => cls.set(key, value),
  } as unknown as ClsService;
  const revocations = {
    isRevoked: isRevoked as RevocationStore['isRevoked'],
    revoke: vi.fn(),
  } as unknown as RevocationStore;

  const guard = new JwtAuthGuard(
    reflector,
    clsService,
    { verify } as never,
    revocations,
  );

  return { guard, request, cls, verify, isRevoked };
}

function contextFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    const response = (error as HttpException).getResponse() as {
      code?: string;
    };
    return response.code ?? 'none';
  }
  throw new Error('expected the guard to reject');
}

function verified(h: Harness, claims: AccessTokenClaims = CLAIMS): Harness {
  h.request.headers.authorization = 'Bearer valid-token';
  h.verify.mockResolvedValue(claims);
  h.isRevoked.mockResolvedValue(false);
  return h;
}

describe('JwtAuthGuard (F6b, BR-01, BR-09)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('denies a route that declares no access level or role', async () => {
    const h = harness();

    await expect(
      h.guard.canActivate(contextFor(h.request)),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('allows a route that explicitly declares @Public()', async () => {
    const h = harness('public');

    await expect(h.guard.canActivate(contextFor(h.request))).resolves.toBe(
      true,
    );
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.isRevoked).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Basic abc', 'Bearer', 'Bearer one two', 'Token abc'])(
    'rejects the malformed authorization header %s',
    async (header) => {
      const h = harness('traveller');
      if (header !== undefined) h.request.headers.authorization = header;

      expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
        ErrorCode.UNAUTHORIZED,
      );
      expect(h.verify).not.toHaveBeenCalled();
    },
  );

  it('distinguishes an expired token from an invalid one', async () => {
    const expired = harness('traveller');
    expired.request.headers.authorization = 'Bearer expired-token';
    expired.verify.mockRejectedValue(
      new AccessTokenVerificationError('expired', 'Token expired'),
    );
    expect(
      await codeOf(expired.guard.canActivate(contextFor(expired.request))),
    ).toBe(ErrorCode.TOKEN_EXPIRED);

    const invalid = harness('traveller');
    invalid.request.headers.authorization = 'Bearer broken-token';
    invalid.verify.mockRejectedValue(
      new AccessTokenVerificationError('invalid', 'Bad signature'),
    );
    expect(
      await codeOf(invalid.guard.canActivate(contextFor(invalid.request))),
    ).toBe(ErrorCode.TOKEN_INVALID);
  });

  it('treats an unexpected verifier failure as an invalid token', async () => {
    const h = harness('traveller');
    h.request.headers.authorization = 'Bearer token';
    h.verify.mockRejectedValue(new Error('boom'));

    expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
      ErrorCode.TOKEN_INVALID,
    );
  });

  it('rejects a revoked token before checking its access level', async () => {
    const h = harness('traveller');
    h.request.headers.authorization = 'Bearer valid-token';
    h.verify.mockResolvedValue(CLAIMS);
    h.isRevoked.mockResolvedValue(true);

    expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
      ErrorCode.TOKEN_REVOKED,
    );
    expect(h.isRevoked).toHaveBeenCalledWith(CLAIMS);
  });

  it('populates request.user and the CLS caller from verified claims', async () => {
    const h = verified(harness('traveller'));

    await expect(h.guard.canActivate(contextFor(h.request))).resolves.toBe(
      true,
    );

    expect(h.request.user).toEqual({
      accountId: 'account-1',
      sessionId: 'session-1',
      jti: 'jti-1',
      level: 'traveller',
      roles: ['operator'],
      bookable: false,
      expiresAt: 1_760_000_900,
    });
    expect(h.cls.get(CALLER_ACCOUNT_ID_KEY)).toBe('account-1');
    expect(h.cls.get(CALLER_SESSION_ID_KEY)).toBe('session-1');
    expect(h.cls.get(CALLER_JTI_KEY)).toBe('jti-1');
    expect(h.cls.get(CALLER_ROLES_KEY)).toEqual(['operator']);
    expect(h.cls.get(CALLER_BOOKABLE_KEY)).toBe(false);
    expect(h.cls.get(CALLER_ACCESS_LEVEL_KEY)).toBe('traveller');
    expect(h.cls.get(CALLER_ACCESS_EXPIRES_AT_KEY)).toBe(1_760_000_900);
  });

  it.each([
    ['traveller' as const, 'traveller' as const],
    ['bookable' as const, 'bookable' as const],
  ])('allows level %s for a token at %s', async (required, level) => {
    const h = verified(harness(required), {
      ...CLAIMS,
      lvl: level,
      bkbl: level === 'bookable',
    });

    await expect(h.guard.canActivate(contextFor(h.request))).resolves.toBe(
      true,
    );
  });

  it('allows a role route when the token carries that role', async () => {
    const h = verified(harness(undefined, ['operator']));

    await expect(h.guard.canActivate(contextFor(h.request))).resolves.toBe(
      true,
    );
  });

  it('treats multiple required roles as any-of', async () => {
    const h = verified(harness(undefined, ['conductor', 'operator']));

    await expect(h.guard.canActivate(contextFor(h.request))).resolves.toBe(
      true,
    );
  });

  it.each([
    ['operator' as const, 'conductor' as const],
    ['conductor' as const, 'operator' as const],
  ])('refuses a %s token on a %s route', async (tokenRole, requiredRole) => {
    const h = verified(harness(undefined, [requiredRole]), {
      ...CLAIMS,
      roles: [tokenRole],
    });

    expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it.each(['operator' as const, 'conductor' as const])(
    'refuses a traveller token (no roles) on a %s route',
    async (requiredRole) => {
      const h = verified(harness(undefined, [requiredRole]), {
        ...CLAIMS,
        roles: [],
      });

      expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
        ErrorCode.FORBIDDEN,
      );
    },
  );

  it('does not let a staff token satisfy bookable implicitly', async () => {
    const h = verified(harness('bookable'), {
      ...CLAIMS,
      lvl: 'traveller',
      roles: ['operator'],
      bkbl: false,
    });

    expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
      ErrorCode.PROFILE_INCOMPLETE,
    );
  });

  it('uses PROFILE_INCOMPLETE when only bookable is missing (BR-10)', async () => {
    const h = verified(harness('bookable'), {
      ...CLAIMS,
      lvl: 'traveller',
      roles: [],
      bkbl: false,
    });

    expect(await codeOf(h.guard.canActivate(contextFor(h.request)))).toBe(
      ErrorCode.PROFILE_INCOMPLETE,
    );
    expect(ACCESS_LEVEL_RANK.traveller).toBeLessThan(
      ACCESS_LEVEL_RANK.bookable,
    );
  });
});
