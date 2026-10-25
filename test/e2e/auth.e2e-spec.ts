import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  ForgotPasswordResponseDto,
  ResetPasswordResponseDto,
  SignInResponseDto,
  SignOutResponseDto,
  SignUpResponseDto,
  TokenPairDto,
  VerifyEmailResponseDto,
} from '@app/contracts';
import {
  AUTH_BASE_URL,
  CONDUCTOR_SEED_EMAIL,
  CONDUCTOR_SEED_PASSWORD,
  DEFAULT_PASSWORD,
  EMAIL_QUEUE,
  GATEWAY_URL,
  OPERATOR_SEED_EMAIL,
  OPERATOR_SEED_PASSWORD,
  clearMailpit,
  redisGet,
  seedStaff,
  signUp,
  startStack,
  stopStack,
  waitFor,
  waitForConsumer,
  waitForEmailCode,
  waitForGateway,
  waitForServiceReady,
} from './support/stack.js';

/**
 * The AUTH-1/AUTH-2/AUTH-3 story, end to end against the real Compose stack.
 *
 * Every request goes through the gateway, so this is the only test that proves
 * the edge, the gRPC adapter, identity's use cases, the outbox relay, the
 * gateway revocation consumer and Mailpit all agree with each other. Unit
 * specs pin each piece; this pins the wiring.
 */

const NEW_PASSWORD = 'N3w!Passw0rd';
const SIGN_UP_SUBJECT = 'Your Train verification code';
const PASSWORD_RESET_SUBJECT = 'Reset your Train password';

/** Gateway consumer queue for identity's session-revoked events. */
const SESSION_REVOKED_QUEUE = 'gateway.identity-session-revoked';

interface AccessTokenClaims {
  sub: string;
  sid: string;
  jti: string;
  lvl: string;
  roles: string[];
  bkbl: boolean;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

interface EnvelopeError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

function decodeAccessToken(token: string): AccessTokenClaims {
  const payload = token.split('.')[1];
  if (!payload) {
    throw new Error('The access token is not a JWT');
  }
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as AccessTokenClaims;
}

async function post<T>(
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<{ status: number; body: ApiResponse<T> }> {
  const response = await fetch(`${AUTH_BASE_URL}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `e2e-auth-${randomUUID()}`,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as ApiResponse<T>,
  };
}

function expectSuccess<T>(
  result: { status: number; body: ApiResponse<T> },
  status = 200,
): T {
  expect(result.status, JSON.stringify(result.body.error)).toBe(status);
  expect(result.body.error).toBeNull();
  expect(result.body.data).not.toBeNull();
  return result.body.data as T;
}

function expectError<T>(
  result: { status: number; body: ApiResponse<T> },
  status: number,
  code: string,
): EnvelopeError {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.body.success).toBe(false);
  expect(result.body.data).toBeNull();
  expect(result.body.error?.code).toBe(code);
  return result.body.error as EnvelopeError;
}

describe('Authentication edge to identity', () => {
  beforeAll(async () => {
    startStack();
    await waitForGateway();
    await waitForServiceReady('identity');
    seedStaff();
    await waitForServiceReady('notification');
    await waitForConsumer(EMAIL_QUEUE);
    await waitForConsumer(SESSION_REVOKED_QUEUE);
  }, 1_200_000);

  afterAll(() => {
    stopStack();
  }, 300_000);

  it('signs up, verifies, signs in, rotates, signs out and rejects the revoked session', async () => {
    await clearMailpit();
    const run = `auth-lifecycle-${Date.now()}`;
    const email = `${run}@example.com`;

    const signUpResult = await signUp(email, 'en', `${run}-sign-up`);
    expect(signUpResult.status).toBe(201);
    expect(signUpResult.body.error).toBeNull();
    const account = signUpResult.body.data as SignUpResponseDto;
    expect(account.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.maskedEmail).toBe('a***@example.com');
    expect(account.language).toBe('en');

    const code = await waitForEmailCode(email, SIGN_UP_SUBJECT);
    expect(code).toMatch(/^\d{6}$/);

    // Correct password on an unverified account is a 200 with no tokens: the
    // response tells the client to verify without revealing anything extra.
    const pending = await post<SignInResponseDto>('sign-in', {
      email,
      password: DEFAULT_PASSWORD,
    });
    const pendingBody = expectSuccess(pending);
    expect(pendingBody.verificationRequired).toBe(true);
    expect(pendingBody.tokens).toBeNull();

    // A wrong code is the documented business error, and the attempt counter
    // survives the rejected request.
    const wrongCode = code === '000000' ? '111111' : '000000';
    expectError(
      await post('verify-email', { email, code: wrongCode }),
      400,
      'INVALID_VERIFICATION_CODE',
    );

    const verified = await post<VerifyEmailResponseDto>('verify-email', {
      email,
      code,
    });
    const firstPair = expectSuccess(verified);
    expect(firstPair.accountId).toBe(account.accountId);
    expect(firstPair.maskedEmail).toBe('a***@example.com');
    expect(firstPair.tokenType).toBe('Bearer');
    expect(firstPair.accessToken.split('.')).toHaveLength(3);
    expect(firstPair.refreshToken.length).toBeGreaterThan(20);

    const claims = decodeAccessToken(firstPair.accessToken);
    expect(claims.sub).toBe(account.accountId);
    expect(claims.sid).toBeTruthy();
    expect(claims.jti).toBeTruthy();
    expect(claims.lvl).toBe('traveller');
    expect(claims.bkbl).toBe(false);
    expect(claims.iss).toBe('train-app-identity');
    expect(claims.aud).toBe('train-app-gateway');
    // F6a: identity facts, never the address, in the token.
    expect(JSON.stringify(claims)).not.toContain(email);
    expect(JSON.stringify(claims)).not.toContain('@');

    const signIn = await post<SignInResponseDto>('sign-in', {
      email,
      password: DEFAULT_PASSWORD,
      deviceId: 'e2e-device',
    });
    const signInBody = expectSuccess(signIn);
    expect(signInBody.verificationRequired).toBe(false);
    expect(signInBody.tokens).not.toBeNull();
    const session = signInBody.tokens as TokenPairDto;

    const rotatedResult = await post<TokenPairDto>('refresh', {
      refreshToken: session.refreshToken,
    });
    const rotated = expectSuccess(rotatedResult);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.accessToken).not.toBe(session.accessToken);

    // Two requests racing on the same refresh token get the same successor
    // while the 10-second grace window is open, not a theft alarm.
    const replayResult = await post<TokenPairDto>('refresh', {
      refreshToken: session.refreshToken,
    });
    const replayed = expectSuccess(replayResult);
    expect(replayed.refreshToken).toBe(rotated.refreshToken);
    expect(replayed.accessToken).toBe(rotated.accessToken);

    const signedOut = await post<SignOutResponseDto>(
      'sign-out',
      { refreshToken: rotated.refreshToken },
      rotated.accessToken,
    );
    expect(expectSuccess(signedOut)).toEqual({ revoked: true });

    const sessionId = decodeAccessToken(rotated.accessToken).sid;
    await waitFor(
      'the gateway to apply the sign-out revocation',
      () => redisGet(`auth:revoked:sid:${sessionId}`) === '1',
      30_000,
    );

    expectError(
      await post(
        'sign-out',
        { refreshToken: rotated.refreshToken },
        rotated.accessToken,
      ),
      401,
      'TOKEN_REVOKED',
    );

    expectError(
      await post('refresh', { refreshToken: rotated.refreshToken }),
      401,
      'SESSION_REVOKED',
    );
  }, 600_000);

  it('seeds one operator and one conductor, and keeps their staff routes separate', async () => {
    const operatorSignIn = await post<SignInResponseDto>('sign-in', {
      email: OPERATOR_SEED_EMAIL,
      password: OPERATOR_SEED_PASSWORD,
    });
    const operator = expectSuccess(operatorSignIn);
    expect(operator.tokens).not.toBeNull();
    const operatorToken = (operator.tokens as TokenPairDto).accessToken;
    const operatorClaims = decodeAccessToken(operatorToken);
    expect(operatorClaims.lvl).toBe('traveller');
    expect(operatorClaims.roles).toEqual(['operator']);
    expect(operatorClaims.bkbl).toBe(false);

    const conductorSignIn = await post<SignInResponseDto>('sign-in', {
      email: CONDUCTOR_SEED_EMAIL,
      password: CONDUCTOR_SEED_PASSWORD,
    });
    const conductor = expectSuccess(conductorSignIn);
    expect(conductor.tokens).not.toBeNull();
    const conductorToken = (conductor.tokens as TokenPairDto).accessToken;
    const conductorClaims = decodeAccessToken(conductorToken);
    expect(conductorClaims.lvl).toBe('traveller');
    expect(conductorClaims.roles).toEqual(['conductor']);

    expect(
      expectSuccess(
        await post<{ role: string }>('staff/operator', {}, operatorToken),
      ),
    ).toEqual({ role: 'operator' });
    expect(
      expectSuccess(
        await post<{ role: string }>('staff/conductor', {}, conductorToken),
      ),
    ).toEqual({ role: 'conductor' });

    expectError(
      await post('staff/conductor', {}, operatorToken),
      403,
      'FORBIDDEN',
    );
    expectError(
      await post('staff/operator', {}, conductorToken),
      403,
      'FORBIDDEN',
    );
  }, 300_000);

  it('resets the password, revokes every session at the edge, and keeps forgot-password non-enumerating', async () => {
    await clearMailpit();
    const run = `auth-reset-${Date.now()}`;
    const email = `${run}@example.com`;

    const signUpResult = await signUp(email, 'en', `${run}-sign-up`);
    expect(signUpResult.status).toBe(201);
    const account = signUpResult.body.data as SignUpResponseDto;

    const signUpCode = await waitForEmailCode(email, SIGN_UP_SUBJECT);
    const verified = await post<VerifyEmailResponseDto>('verify-email', {
      email,
      code: signUpCode,
    });
    const firstSession = expectSuccess(verified);

    const signIn = await post<SignInResponseDto>('sign-in', {
      email,
      password: DEFAULT_PASSWORD,
      deviceId: 'e2e-second-session',
    });
    const signInBody = expectSuccess(signIn);
    expect(signInBody.tokens).not.toBeNull();
    const secondSession = signInBody.tokens as TokenPairDto;

    // BR-09: an unknown address gets exactly the same answer as a real one.
    const unknownForgot = await post<ForgotPasswordResponseDto>(
      'forgot-password',
      { email: `nobody-${run}@example.com` },
    );
    const unknownForgotBody = expectSuccess(unknownForgot, 202);

    const forgot = await post<ForgotPasswordResponseDto>('forgot-password', {
      email,
    });
    const forgotBody = expectSuccess(forgot, 202);
    expect(forgotBody).toEqual(unknownForgotBody);
    expect(forgotBody.secondsRemaining).toBe(120);

    const resetCode = await waitForEmailCode(email, PASSWORD_RESET_SUBJECT);
    const reset = await post<ResetPasswordResponseDto>('reset-password', {
      email,
      code: resetCode,
      newPassword: NEW_PASSWORD,
    });
    expect(expectSuccess(reset)).toEqual({ reset: true });

    await waitFor(
      'the gateway to apply the account-wide reset revocation',
      () => redisGet(`auth:revoked:account:${account.accountId}`).length > 0,
      30_000,
    );
    const revokedAt = Number(
      redisGet(`auth:revoked:account:${account.accountId}`),
    );
    expect(Number.isFinite(revokedAt)).toBe(true);
    expect(
      decodeAccessToken(secondSession.accessToken).iat * 1000,
    ).toBeLessThanOrEqual(revokedAt);

    // Both sessions existed before the reset. The account marker rejects both
    // access tokens, not just the session that requested the reset.
    for (const pair of [firstSession, secondSession]) {
      expectError(
        await post(
          'sign-out',
          { refreshToken: 'irrelevant-after-reset' },
          pair.accessToken,
        ),
        401,
        'TOKEN_REVOKED',
      );
      expectError(
        await post('refresh', { refreshToken: pair.refreshToken }),
        401,
        'SESSION_REVOKED',
      );
    }

    expectError(
      await post('sign-in', { email, password: DEFAULT_PASSWORD }),
      401,
      'INVALID_CREDENTIALS',
    );

    const newSignIn = await post<SignInResponseDto>('sign-in', {
      email,
      password: NEW_PASSWORD,
    });
    const newSignInBody = expectSuccess(newSignIn);
    expect(newSignInBody.verificationRequired).toBe(false);
    expect(newSignInBody.tokens?.accessToken).toBeTruthy();
  }, 600_000);

  it('denies routes without metadata and keeps health outside the API prefix', async () => {
    expectError(
      await post('sign-out', { refreshToken: 'anything' }),
      401,
      'UNAUTHORIZED',
    );

    const live = await fetch(`${GATEWAY_URL}/health/live`);
    expect(live.status).toBe(200);

    const prefixedHealth = await fetch(`${GATEWAY_URL}/api/v1/health/live`);
    expect(prefixedHealth.status).toBe(404);
  }, 120_000);
});
