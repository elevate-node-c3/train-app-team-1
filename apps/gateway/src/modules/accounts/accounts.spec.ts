import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import * as grpc from '@grpc/grpc-js';
import {
  ErrorCode,
  type SignUpResponseDto,
  type VerifyEmailResponseDto,
} from '@app/contracts';
import {
  CALLER_ACCOUNT_ID_HEADER,
  CALLER_ACCOUNT_ID_KEY,
  CALLER_BOOKABLE_HEADER,
  CALLER_BOOKABLE_KEY,
  CALLER_JTI_HEADER,
  CALLER_JTI_KEY,
  CALLER_ROLES_HEADER,
  CALLER_ROLES_KEY,
  CALLER_SESSION_ID_HEADER,
  CALLER_SESSION_ID_KEY,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from '@app/common';
import {
  ACCOUNTS_CALL_TIMEOUT_MS,
  IdentityAccountsGrpcAdapter,
} from './infrastructure/grpc/identity-accounts.grpc-adapter.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const CORRELATION_ID = 'gateway-corr-1';
const METHODS = [
  'signUp',
  'verifyEmail',
  'resendVerification',
  'signIn',
  'refreshToken',
  'signOut',
  'forgotPassword',
  'resetPassword',
] as const;
type Method = (typeof METHODS)[number];

const WIRE_TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer',
  accessExpiresIn: 900,
  refreshExpiresIn: 2_592_000,
};

const SIGN_UP_RESPONSE: SignUpResponseDto = {
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  maskedEmail: 'u***@example.com',
  language: 'ar',
  resendAfterSeconds: 120,
};

interface CapturedCall {
  method: Method;
  request: Record<string, unknown>;
  metadata: grpc.Metadata;
  options: grpc.CallOptions;
}

interface Reply {
  error?: grpc.ServiceError;
  response?: unknown;
}

interface FakeClient {
  client: Record<string, unknown>;
  calls: CapturedCall[];
  close: ReturnType<typeof vi.fn>;
}

function fakeClient(
  reply: (method: Method, request: Record<string, unknown>) => Reply = () =>
    ({}),
): FakeClient {
  const calls: CapturedCall[] = [];
  const close = vi.fn();
  const client: Record<string, unknown> = { close };

  for (const method of METHODS) {
    client[method] = (
      request: Record<string, unknown>,
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
      callback: (error: grpc.ServiceError | null, response?: unknown) => void,
    ) => {
      calls.push({ method, request, metadata, options });
      const outcome = reply(method, request);
      callback(outcome.error ?? null, outcome.response);
      return {};
    };
  }

  return { client, calls, close };
}

function attach(
  adapter: IdentityAccountsGrpcAdapter,
  client: Record<string, unknown>,
): void {
  (adapter as unknown as { client: Record<string, unknown> }).client = client;
}

function fakeCls(values: Record<string, unknown> = {}): ClsService {
  const store = new Map<string, unknown>(Object.entries(values));
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as unknown as ClsService;
}

function serviceError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new grpc.Metadata(),
  }) as grpc.ServiceError;
}

function adapterWith(
  reply?: (method: Method, request: Record<string, unknown>) => Reply,
  cls: ClsService = fakeCls({ [CORRELATION_ID_KEY]: CORRELATION_ID }),
): { adapter: IdentityAccountsGrpcAdapter; fake: FakeClient } {
  const adapter = new IdentityAccountsGrpcAdapter(cls);
  const fake = fakeClient(reply);
  attach(adapter, fake.client);
  return { adapter, fake };
}

async function httpErrorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('expected the adapter to reject');
}

describe('IdentityAccountsGrpcAdapter (F5, ADR-0004)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards sign-up with correlation metadata and the call budget', async () => {
    const { adapter, fake } = adapterWith(() => ({
      response: SIGN_UP_RESPONSE,
    }));

    await expect(
      adapter.signUp({
        email: 'user@example.com',
        password: 'Str0ng!Pass',
        language: 'en',
      }),
    ).resolves.toEqual(SIGN_UP_RESPONSE);

    const call = fake.calls[0];
    expect(call.method).toBe('signUp');
    expect(call.request).toEqual({
      email: 'user@example.com',
      password: 'Str0ng!Pass',
      language: 'en',
    });
    expect(call.metadata.get(CORRELATION_ID_HEADER)).toEqual([CORRELATION_ID]);
    expect(call.options.deadline).toBe(NOW.getTime() + ACCOUNTS_CALL_TIMEOUT_MS);
  });

  it('sends the empty language for identity’s Arabic fallback', async () => {
    const { adapter, fake } = adapterWith(() => ({
      response: SIGN_UP_RESPONSE,
    }));

    await adapter.signUp({
      email: 'user@example.com',
      password: 'Str0ng!Pass',
    });

    expect(fake.calls[0].request.language).toBe('');
  });

  it('flattens a verified e-mail into the edge token pair', async () => {
    const { adapter, fake } = adapterWith(() => ({
      response: {
        tokens: WIRE_TOKENS,
        accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        maskedEmail: 'u***@example.com',
      },
    }));

    const result = await adapter.verifyEmail({
      email: 'user@example.com',
      code: '123456',
      deviceId: 'device-1',
    });

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      accessExpiresIn: 900,
      refreshExpiresIn: 2_592_000,
      accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      maskedEmail: 'u***@example.com',
    });
    expect(fake.calls[0].request).toEqual({
      email: 'user@example.com',
      code: '123456',
      deviceId: 'device-1',
    });
  });

  it('turns a missing token pair into a server error, never a null token', async () => {
    const { adapter } = adapterWith(() => ({
      response: { accountId: 'a', maskedEmail: 'u***@example.com' },
    }));

    await expect(
      adapter.verifyEmail({ email: 'user@example.com', code: '123456' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('returns a pending sign-in with null tokens', async () => {
    const { adapter, fake } = adapterWith(() => ({
      response: {
        verificationRequired: true,
        maskedEmail: 'u***@example.com',
        secondsRemaining: 120,
      },
    }));

    await expect(
      adapter.signIn({
        email: 'user@example.com',
        password: 'Str0ng!Pass',
        deviceId: 'device-1',
      }),
    ).resolves.toEqual({
      verificationRequired: true,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
      tokens: null,
    });
    expect(fake.calls[0].request).toEqual({
      email: 'user@example.com',
      password: 'Str0ng!Pass',
      deviceId: 'device-1',
    });
  });

  it('flattens a successful sign-in', async () => {
    const { adapter } = adapterWith(() => ({
      response: {
        verificationRequired: false,
        maskedEmail: 'u***@example.com',
        secondsRemaining: 0,
        tokens: WIRE_TOKENS,
      },
    }));

    await expect(
      adapter.signIn({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    ).resolves.toMatchObject({
      verificationRequired: false,
      tokens: { accessToken: 'access-token', tokenType: 'Bearer' },
    });
  });

  it('flattens refresh and rejects an empty successor pair', async () => {
    const success = adapterWith(() => ({ response: { tokens: WIRE_TOKENS } }));
    await expect(
      success.adapter.refreshToken({ refreshToken: 'old-refresh' }),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(success.fake.calls[0].request).toEqual({ refreshToken: 'old-refresh' });

    const empty = adapterWith(() => ({ response: {} }));
    await expect(
      empty.adapter.refreshToken({ refreshToken: 'old-refresh' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('forwards sign-out with the caller context minted from the token', async () => {
    const { adapter, fake } = adapterWith(() => ({
      response: { revoked: true },
    }));
    const expiresAt = '2026-10-24T10:15:00.000Z';

    await expect(
      adapter.signOut({
        refreshToken: 'refresh-token',
        sessionId: 'session-1',
        jti: 'jti-1',
        accessTokenExpiresAt: expiresAt,
      }),
    ).resolves.toEqual({ revoked: true });

    expect(fake.calls[0].request).toEqual({
      refreshToken: 'refresh-token',
      sessionId: 'session-1',
      jti: 'jti-1',
      accessTokenExpiresAt: expiresAt,
    });
  });

  it('forwards resend, forgot-password and reset-password', async () => {
    const { adapter, fake } = adapterWith((method) => {
      if (method === 'resendVerification') {
        return {
          response: { maskedEmail: 'u***@example.com', secondsRemaining: 120 },
        };
      }
      if (method === 'forgotPassword') {
        return { response: { secondsRemaining: 120 } };
      }
      return { response: { reset: true } };
    });

    await expect(
      adapter.resendVerification({ email: 'user@example.com' }),
    ).resolves.toEqual({
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
    });
    await expect(
      adapter.forgotPassword({ email: 'user@example.com' }),
    ).resolves.toEqual({ secondsRemaining: 120 });
    await expect(
      adapter.resetPassword({
        email: 'user@example.com',
        code: '123456',
        newPassword: 'N3w!Passw0rd',
      }),
    ).resolves.toEqual({ reset: true });

    expect(fake.calls.map((call) => call.method)).toEqual([
      'resendVerification',
      'forgotPassword',
      'resetPassword',
    ]);
    expect(fake.calls[1].request).toEqual({ email: 'user@example.com' });
    expect(fake.calls[2].request).toEqual({
      email: 'user@example.com',
      code: '123456',
      newPassword: 'N3w!Passw0rd',
    });
  });

  it('propagates the verified caller to identity metadata', async () => {
    const cls = fakeCls({
      [CORRELATION_ID_KEY]: CORRELATION_ID,
      [CALLER_ACCOUNT_ID_KEY]: 'account-1',
      [CALLER_SESSION_ID_KEY]: 'session-1',
      [CALLER_JTI_KEY]: 'jti-1',
      [CALLER_ROLES_KEY]: ['operator'],
      [CALLER_BOOKABLE_KEY]: true,
    });
    const { adapter, fake } = adapterWith(
      () => ({ response: { revoked: true } }),
      cls,
    );

    await adapter.signOut({
      refreshToken: 'refresh-token',
      sessionId: 'session-1',
      jti: 'jti-1',
      accessTokenExpiresAt: '2026-10-24T10:15:00.000Z',
    });

    const metadata = fake.calls[0].metadata;
    expect(metadata.get(CALLER_ACCOUNT_ID_HEADER)).toEqual(['account-1']);
    expect(metadata.get(CALLER_SESSION_ID_HEADER)).toEqual(['session-1']);
    expect(metadata.get(CALLER_JTI_HEADER)).toEqual(['jti-1']);
    expect(metadata.get(CALLER_ROLES_HEADER)).toEqual(['operator']);
    expect(metadata.get(CALLER_BOOKABLE_HEADER)).toEqual(['true']);
  });

  it('restores a known business code and its retry hint', async () => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(
        grpc.status.ResourceExhausted,
        JSON.stringify({
          code: ErrorCode.RESEND_TOO_SOON,
          retryAfterSeconds: 89.2,
        }),
      ),
    }));

    const error = await httpErrorOf(
      adapter.resendVerification({ email: 'user@example.com' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toEqual({
      code: ErrorCode.RESEND_TOO_SOON,
      retryAfterSeconds: 90,
    });
  });

  it.each([
    [ErrorCode.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED],
    [ErrorCode.EMAIL_ALREADY_REGISTERED, HttpStatus.CONFLICT],
    [ErrorCode.INVALID_VERIFICATION_CODE, HttpStatus.BAD_REQUEST],
    [ErrorCode.ACCOUNT_DISABLED, HttpStatus.FORBIDDEN],
    [ErrorCode.REFRESH_TOKEN_REUSE_DETECTED, HttpStatus.UNAUTHORIZED],
  ])('maps %s to HTTP %i', async (code, status) => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(
        grpc.status.Internal,
        JSON.stringify({ code }),
      ),
    }));

    const error = await httpErrorOf(
      adapter.signIn({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    );

    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({ code });
  });

  it('does not trust an unknown code string from the transport', async () => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(
        grpc.status.Internal,
        JSON.stringify({ code: 'TOTALLY_MADE_UP' }),
      ),
    }));

    const error = await httpErrorOf(
      adapter.signUp({
        email: 'user@example.com',
        password: 'Str0ng!Pass',
      }),
    );

    expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(error.getResponse()).toEqual({
      code: ErrorCode.INTERNAL_SERVER_ERROR,
    });
  });

  it('does not turn a transport bug into a 503', async () => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(grpc.status.Internal, 'sensitive internal detail'),
    }));

    const error = await httpErrorOf(
      adapter.signUp({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(error.getResponse())).not.toContain(
      'sensitive internal detail',
    );
  });

  it('maps UNAVAILABLE to a 503 service-unavailable envelope', async () => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(grpc.status.UNAVAILABLE, 'transport down'),
    }));

    const error = await httpErrorOf(
      adapter.signUp({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
    });
  });

  it('maps DEADLINE_EXCEEDED to a 504 gateway-timeout envelope', async () => {
    const { adapter } = adapterWith(() => ({
      error: serviceError(grpc.status.DEADLINE_EXCEEDED, 'too slow'),
    }));

    const error = await httpErrorOf(
      adapter.signUp({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    );

    expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect(error.getResponse()).toMatchObject({
      code: ErrorCode.GATEWAY_TIMEOUT,
    });
  });

  it('answers 503 without a channel when the adapter never initialised', async () => {
    const adapter = new IdentityAccountsGrpcAdapter(fakeCls());

    await expect(
      adapter.signUp({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('closes the channel on module destroy', () => {
    const { adapter, fake } = adapterWith();

    adapter.onModuleDestroy();

    expect(fake.close).toHaveBeenCalledOnce();
    expect(() => adapter.onModuleDestroy()).not.toThrow();
  });
});

describe('IdentityAccountsGrpcAdapter wire contract', () => {
  it('returns a verification response shaped like the HTTP DTO', async () => {
    const { adapter } = adapterWith(() => ({
      response: {
        tokens: WIRE_TOKENS,
        accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        maskedEmail: 'u***@example.com',
      },
    }));

    const result: VerifyEmailResponseDto = await adapter.verifyEmail({
      email: 'user@example.com',
      code: '123456',
    });

    expect(Object.keys(result).sort()).toEqual([
      'accessExpiresIn',
      'accessToken',
      'accountId',
      'maskedEmail',
      'refreshExpiresIn',
      'refreshToken',
      'tokenType',
    ]);
  });
});
