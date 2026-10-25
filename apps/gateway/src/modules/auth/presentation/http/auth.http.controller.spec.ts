import { describe, expect, it, vi } from 'vitest';
import {
  type ForgotPasswordResponseDto,
  type RefreshResponseDto,
  type ResendVerificationResponseDto,
  type ResetPasswordResponseDto,
  type SignInResponseDto,
  type SignOutResponseDto,
  type SignUpResponseDto,
  type VerifyEmailResponseDto,
} from '@app/contracts';
import {
  ACCESS_LEVEL_KEY,
  RATE_LIMIT_KEY,
  type AuthenticatedCaller,
  type RateLimitOptions,
} from '@app/common';
import { AuthHttpController } from './auth.http.controller.js';
import type { AccountsClientPort } from '../../../accounts/application/ports/accounts.port.js';

const TOKENS: RefreshResponseDto = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer',
  accessExpiresIn: 900,
  refreshExpiresIn: 2_592_000,
};

const SIGN_UP: SignUpResponseDto = {
  accountId: 'account-1',
  maskedEmail: 'u***@example.com',
  language: 'ar',
  resendAfterSeconds: 120,
};
const VERIFIED: VerifyEmailResponseDto = {
  ...TOKENS,
  accountId: 'account-1',
  maskedEmail: 'u***@example.com',
};
const SIGN_IN: SignInResponseDto = {
  verificationRequired: false,
  maskedEmail: 'u***@example.com',
  secondsRemaining: 0,
  tokens: TOKENS,
};
const RESEND: ResendVerificationResponseDto = {
  maskedEmail: 'u***@example.com',
  secondsRemaining: 120,
};
const FORGOT: ForgotPasswordResponseDto = { secondsRemaining: 120 };
const RESET: ResetPasswordResponseDto = { reset: true };
const SIGN_OUT: SignOutResponseDto = { revoked: true };

function harness(): {
  controller: AuthHttpController;
  port: { [K in keyof AccountsClientPort]: ReturnType<typeof vi.fn> };
} {
  const port = {
    signUp: vi.fn(async () => SIGN_UP),
    verifyEmail: vi.fn(async () => VERIFIED),
    resendVerification: vi.fn(async () => RESEND),
    signIn: vi.fn(async () => SIGN_IN),
    refreshToken: vi.fn(async () => TOKENS),
    signOut: vi.fn(async () => SIGN_OUT),
    forgotPassword: vi.fn(async () => FORGOT),
    resetPassword: vi.fn(async () => RESET),
  };
  return {
    controller: new AuthHttpController(port as unknown as AccountsClientPort),
    port,
  };
}

function caller(overrides: Partial<AuthenticatedCaller> = {}): AuthenticatedCaller {
  return {
    accountId: 'account-1',
    sessionId: 'session-1',
    jti: 'jti-1',
    level: 'traveller',
    roles: [],
    bookable: true,
    expiresAt: 1_760_000_900,
    ...overrides,
  };
}

describe('AuthHttpController (F6b, BR-01)', () => {
  it('forwards every public auth command to the accounts port unchanged', async () => {
    const { controller, port } = harness();

    await expect(
      controller.signUp({
        email: 'user@example.com',
        password: 'Str0ng!Pass',
        language: 'en',
      }),
    ).resolves.toBe(SIGN_UP);
    expect(port.signUp).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'Str0ng!Pass',
      language: 'en',
    });

    const verify = {
      email: 'user@example.com',
      code: '123456',
      deviceId: 'device-1',
    };
    await expect(controller.verifyEmail(verify)).resolves.toBe(VERIFIED);
    expect(port.verifyEmail).toHaveBeenCalledWith(verify);

    const resend = { email: 'user@example.com' };
    await expect(controller.resendVerification(resend)).resolves.toBe(RESEND);
    expect(port.resendVerification).toHaveBeenCalledWith(resend);

    const signIn = {
      email: 'user@example.com',
      password: 'Str0ng!Pass',
      deviceId: 'device-1',
    };
    await expect(controller.signIn(signIn)).resolves.toBe(SIGN_IN);
    expect(port.signIn).toHaveBeenCalledWith(signIn);

    const refresh = { refreshToken: 'refresh-token' };
    await expect(controller.refresh(refresh)).resolves.toBe(TOKENS);
    expect(port.refreshToken).toHaveBeenCalledWith(refresh);

    const forgot = { email: 'user@example.com' };
    await expect(controller.forgotPassword(forgot)).resolves.toBe(FORGOT);
    expect(port.forgotPassword).toHaveBeenCalledWith(forgot);

    const reset = {
      email: 'user@example.com',
      code: '123456',
      newPassword: 'N3w!Passw0rd',
    };
    await expect(controller.resetPassword(reset)).resolves.toBe(RESET);
    expect(port.resetPassword).toHaveBeenCalledWith(reset);
  });

  it('derives sign-out identity from the verified caller, not the body', async () => {
    const { controller, port } = harness();

    await expect(
      controller.signOut(
        { refreshToken: 'refresh-token' },
        caller({ sessionId: 'session-from-token', jti: 'jti-from-token' }),
      ),
    ).resolves.toBe(SIGN_OUT);

    expect(port.signOut).toHaveBeenCalledWith({
      refreshToken: 'refresh-token',
      sessionId: 'session-from-token',
      jti: 'jti-from-token',
      accessTokenExpiresAt: new Date(1_760_000_900_000).toISOString(),
    });
  });

  it('declares every auth route public except sign-out', () => {
    const routes = [
      'signUp',
      'verifyEmail',
      'resendVerification',
      'signIn',
      'refresh',
      'forgotPassword',
      'resetPassword',
    ] as const;

    for (const route of routes) {
      expect(
        Reflect.getMetadata(ACCESS_LEVEL_KEY, AuthHttpController.prototype[route]),
      ).toBe('public');
    }
    const signOutHandler = Object.getOwnPropertyDescriptor(
      AuthHttpController.prototype,
      'signOut',
    )?.value as (...args: never[]) => unknown;
    expect(
      Reflect.getMetadata(ACCESS_LEVEL_KEY, signOutHandler),
    ).toBe('traveller');
  });

  it('pins a rate-limit bucket to every auth route', () => {
    const expected: Record<string, RateLimitOptions> = {
      signUp: { bucket: 'sign-up', limit: 10, windowSeconds: 60 },
      verifyEmail: { bucket: 'verify-email', limit: 10, windowSeconds: 60 },
      resendVerification: {
        bucket: 'resend-verification',
        limit: 3,
        windowSeconds: 300,
      },
      signIn: { bucket: 'sign-in', limit: 10, windowSeconds: 60 },
      refresh: { bucket: 'refresh-token', limit: 60, windowSeconds: 60 },
      signOut: { bucket: 'sign-out', limit: 30, windowSeconds: 60 },
      forgotPassword: { bucket: 'forgot-password', limit: 5, windowSeconds: 300 },
      resetPassword: { bucket: 'reset-password', limit: 10, windowSeconds: 60 },
    };

    for (const [route, options] of Object.entries(expected)) {
      expect(
        Reflect.getMetadata(
          RATE_LIMIT_KEY,
          AuthHttpController.prototype[
            route as keyof AuthHttpController
          ] as Function,
        ),
      ).toEqual(options);
    }
  });
});
