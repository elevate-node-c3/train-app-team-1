import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { validate } from 'class-validator';
import {
  CORRELATION_ID_KEY,
  ConfigurationException,
  DomainException,
  HttpExceptionFilter,
  identityEnvSchema,
  validateEnvOrThrow,
} from '@app/common';
import {
  ACCOUNT_REVOCATION_SERVICE,
  AccountRevocationError,
  DOMAIN_EVENT_PUBLISHER,
  ErrorCode,
  IdentityEventType,
  SESSION_SERVICE,
} from '@app/contracts';
import { IdentityRedisService } from '../../apps/identity/src/persistence/identity-redis.service.js';
import {
  checkPasswordPolicy,
  meetsPasswordPolicy,
} from '../../apps/identity/src/domain/password/password-policy.js';
import { MeetsPasswordPolicy } from '../../apps/identity/src/transport/validation/meets-password-policy.decorator.js';
import { VERIFICATION_CODE_ISSUER } from '../../apps/identity/src/domain/ports/verification-code-issuer.js';
import {
  createFakeIntegrationProviders,
  FakeAccountRevocationService,
  FakeSessionService,
  FakeVerificationCodeIssuer,
  RecordingEventPublisher,
} from '../../apps/identity/src/fakes/index.js';

function captureFilterResponse(exception: unknown) {
  const captured = {
    status: 0,
    body: null as any,
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    status: (s: number) => {
      captured.status = s;
      return { json: (b: any) => (captured.body = b) };
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'accept-language': 'en' } }),
      getResponse: () => res,
    }),
  } as any;
  const cls = {
    get: (key: string) => (key === CORRELATION_ID_KEY ? 'corr-1' : undefined),
  } as unknown as ClsService;

  new HttpExceptionFilter(cls).catch(exception, host);
  return captured;
}

describe('HttpExceptionFilter with DomainException', () => {
  it('keeps the domain code instead of deriving one from the status', () => {
    const { status, body } = captureFilterResponse(
      new DomainException('ACCOUNT_LOCKED', HttpStatus.LOCKED),
    );
    expect(status).toBe(423);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ACCOUNT_LOCKED');
    expect(body.error.meta).toBeUndefined();
    expect(body.correlationId).toBe('corr-1');
  });

  it('passes safe metadata through and sets Retry-After', () => {
    const { status, body, headers } = captureFilterResponse(
      new DomainException('ACCOUNT_LOCKED', HttpStatus.LOCKED, {
        retryAfterSeconds: 812.4,
      }),
    );
    expect(status).toBe(423);
    expect(body.error.meta).toEqual({ retryAfterSeconds: 812.4 });
    expect(headers['Retry-After']).toBe('813');
  });

  it('sets no Retry-After when the error states no wait', () => {
    const { headers } = captureFilterResponse(
      new DomainException('INVALID_CREDENTIALS', HttpStatus.UNAUTHORIZED),
    );
    expect(headers['Retry-After']).toBeUndefined();
  });
});

describe('IdentityRedisService fails closed', () => {
  it('refuses with 503 when no Redis client is configured', async () => {
    const service = new IdentityRedisService();
    const error = await service
      .run(async () => 'unreachable')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(503);
    expect((error as DomainException).code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('turns a failing Redis command into 503 rather than letting the caller continue', async () => {
    const service = new IdentityRedisService();
    (service as any).client = {};

    const error = await service
      .run(async () => {
        throw new Error(
          "Stream isn't writeable and enableOfflineQueue is false",
        );
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).getStatus()).toBe(503);
  });

  it('returns the result of a successful command', async () => {
    const service = new IdentityRedisService();
    const client = { get: async () => '3' };
    (service as any).client = client;

    await expect(service.run((c: any) => c.get('k'))).resolves.toBe('3');
  });
});

describe('identityEnvSchema', () => {
  const baseEnv = {
    PORT: '3000',
    DATABASE_URL: 'postgres://identity:identity_dev@postgres:5432/identity',
    REDIS_URL: 'redis://redis:6379',
    RABBITMQ_URL: 'amqp://train_app:train_app@rabbitmq:5672',
  };

  it('requires IDENTITY_CODE_HMAC_SECRET', () => {
    expect(() =>
      validateEnvOrThrow(identityEnvSchema, baseEnv, 'identity'),
    ).toThrowError(
      /Missing required environment variable 'IDENTITY_CODE_HMAC_SECRET'/,
    );
  });

  it('rejects a short secret without printing it', () => {
    const secret = 'too-short-secret';
    try {
      validateEnvOrThrow(
        identityEnvSchema,
        { ...baseEnv, IDENTITY_CODE_HMAC_SECRET: secret },
        'identity',
      );
      expect.unreachable('Should have thrown ConfigurationException');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConfigurationException);
      expect(err.message).toContain("'IDENTITY_CODE_HMAC_SECRET'");
      expect(err.message).not.toContain(secret);
    }
  });

  it('accepts a secret of at least 32 characters', () => {
    const validated = validateEnvOrThrow(
      identityEnvSchema,
      { ...baseEnv, IDENTITY_CODE_HMAC_SECRET: 'x'.repeat(32) },
      'identity',
    );
    expect((validated as any).IDENTITY_CODE_HMAC_SECRET).toHaveLength(32);
  });
});

describe('Password policy (BR-02)', () => {
  it('accepts a password meeting every rule', () => {
    expect(checkPasswordPolicy('Travel#2026')).toEqual([]);
    expect(meetsPasswordPolicy('Travel#2026')).toBe(true);
  });

  it('reports every rule a password breaks', () => {
    expect(checkPasswordPolicy('abc')).toEqual([
      'TOO_SHORT',
      'MISSING_UPPERCASE',
      'MISSING_DIGIT',
      'MISSING_SYMBOL',
    ]);
  });

  it('rejects passwords over the maximum length', () => {
    expect(checkPasswordPolicy(`Aa1!${'a'.repeat(125)}`)).toEqual(['TOO_LONG']);
  });

  it('counts code points rather than UTF-16 units', () => {
    // 7 code points, 8 UTF-16 units: still too short.
    expect(checkPasswordPolicy('Aa1!bc😀')).toEqual(['TOO_SHORT']);
  });

  it('applies the same rules through the DTO decorator without echoing the value', async () => {
    class ResetDto {
      @MeetsPasswordPolicy()
      newPassword!: string;
    }

    const weak = Object.assign(new ResetDto(), { newPassword: 'weakpass' });
    const [error] = await validate(weak);
    const message = Object.values(error.constraints ?? {}).join(' ');
    expect(error.property).toBe('newPassword');
    expect(message).not.toContain('weakpass');

    const strong = Object.assign(new ResetDto(), {
      newPassword: 'Travel#2026',
    });
    expect(await validate(strong)).toEqual([]);

    const notString = Object.assign(new ResetDto(), { newPassword: 12345678 });
    expect(await validate(notString)).toHaveLength(1);
  });
});

describe('Integration fakes', () => {
  it('FakeSessionService records calls and returns a session', async () => {
    const sessions = new FakeSessionService();
    const session = await sessions.createSession('acc-1', { userAgent: 'ua' });

    expect(sessions.calls).toEqual([
      { accountId: 'acc-1', deviceContext: { userAgent: 'ua' } },
    ]);
    expect(session.sessionId).toBeTruthy();
    expect(Date.parse(session.accessTokenExpiresAt)).toBeGreaterThan(
      Date.now(),
    );

    sessions.failWith(new Error('down'));
    await expect(sessions.createSession('acc-1', {})).rejects.toThrow('down');
  });

  it('FakeAccountRevocationService records revocations and can fail', async () => {
    const revocation = new FakeAccountRevocationService();
    await revocation.revokeAll('acc-1');
    expect(revocation.revokedAccountIds).toEqual(['acc-1']);

    revocation.failNext();
    await expect(revocation.revokeAll('acc-2')).rejects.toBeInstanceOf(
      AccountRevocationError,
    );
  });

  it('RecordingEventPublisher keeps events and filters by type', async () => {
    const publisher = new RecordingEventPublisher();
    await publisher.publish({
      eventId: 'e-1',
      type: IdentityEventType.PASSWORD_RESET,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-1',
      payload: { accountId: 'acc-1' },
    });

    expect(publisher.ofType(IdentityEventType.PASSWORD_RESET)).toHaveLength(1);
    expect(publisher.ofType(IdentityEventType.ACCOUNT_LOCKED)).toHaveLength(0);
  });

  it('FakeVerificationCodeIssuer issues until told to refuse', async () => {
    const issuer = new FakeVerificationCodeIssuer();
    await expect(issuer.issue('acc-1')).resolves.toEqual({ issued: true });

    issuer.refuseFor(95);
    await expect(issuer.issue('acc-1')).resolves.toEqual({
      issued: false,
      retryAfterSeconds: 95,
    });
    expect(issuer.issuedFor).toEqual(['acc-1']);
  });

  it('binds a fake to every integration token', () => {
    const tokens = createFakeIntegrationProviders().map(
      (p) => (p as { provide: unknown }).provide,
    );
    expect(tokens).toEqual([
      SESSION_SERVICE,
      ACCOUNT_REVOCATION_SERVICE,
      DOMAIN_EVENT_PUBLISHER,
      VERIFICATION_CODE_ISSUER,
    ]);
  });
});
