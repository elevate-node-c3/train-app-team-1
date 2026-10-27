import { describe, expect, it, vi } from 'vitest';
import { InternalServerErrorException } from '@nestjs/common';
import type { SignUpResponseDto, VerifyEmailResponseDto } from '@app/contracts';
import { IdentityService } from './identity.service.js';
import type { IdentityGrpcClient } from './identity.grpc.client.js';
import type { WireTokenPair } from './identity.types.js';

const WIRE_TOKENS: WireTokenPair = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer',
  accessExpiresIn: 900,
  refreshExpiresIn: 2_592_000,
};

const SIGN_UP_RESPONSE: SignUpResponseDto = {
  accountId: 'account-1',
  maskedEmail: 'u***@example.com',
  language: 'en',
  resendAfterSeconds: 120,
};

type ClientMethods = Pick<
  IdentityGrpcClient,
  | 'signUp'
  | 'verifyEmail'
  | 'resendVerification'
  | 'signIn'
  | 'refreshToken'
  | 'signOut'
  | 'forgotPassword'
  | 'resetPassword'
>;

function harness(): {
  service: IdentityService;
  client: { [K in keyof ClientMethods]: ReturnType<typeof vi.fn> };
} {
  const client = {
    signUp: vi.fn(async () => SIGN_UP_RESPONSE),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    signIn: vi.fn(),
    refreshToken: vi.fn(),
    signOut: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
  };
  return {
    service: new IdentityService(client as unknown as IdentityGrpcClient),
    client,
  };
}

describe('IdentityService (edge shaping)', () => {
  it('flattens a verified e-mail into the HTTP token pair', async () => {
    const { service, client } = harness();
    client.verifyEmail.mockResolvedValue({
      tokens: WIRE_TOKENS,
      accountId: 'account-1',
      maskedEmail: 'u***@example.com',
    });

    const result: VerifyEmailResponseDto = await service.verifyEmail({
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
      accountId: 'account-1',
      maskedEmail: 'u***@example.com',
    });
  });

  it('turns a missing verification pair into a server error, never a null token', async () => {
    const { service, client } = harness();
    client.verifyEmail.mockResolvedValue({
      accountId: 'account-1',
      maskedEmail: 'u***@example.com',
    });

    await expect(
      service.verifyEmail({ email: 'user@example.com', code: '123456' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('maps a pending sign-in to null tokens', async () => {
    const { service, client } = harness();
    client.signIn.mockResolvedValue({
      verificationRequired: true,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
    });

    await expect(
      service.signIn({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    ).resolves.toEqual({
      verificationRequired: true,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
      tokens: null,
    });
  });

  it('flattens a successful sign-in', async () => {
    const { service, client } = harness();
    client.signIn.mockResolvedValue({
      verificationRequired: false,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 0,
      tokens: WIRE_TOKENS,
    });

    await expect(
      service.signIn({ email: 'user@example.com', password: 'Str0ng!Pass' }),
    ).resolves.toMatchObject({
      verificationRequired: false,
      tokens: { accessToken: 'access-token', tokenType: 'Bearer' },
    });
  });

  it('flattens refresh and rejects an empty successor pair', async () => {
    const { service, client } = harness();
    client.refreshToken.mockResolvedValueOnce({ tokens: WIRE_TOKENS });

    await expect(
      service.refreshToken({ refreshToken: 'old-refresh' }),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    client.refreshToken.mockResolvedValueOnce({});
    await expect(
      service.refreshToken({ refreshToken: 'old-refresh' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('delegates the passthrough commands without reshaping them', async () => {
    const { service, client } = harness();
    client.signOut.mockResolvedValue({ revoked: true });
    client.resendVerification.mockResolvedValue({
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
    });
    client.forgotPassword.mockResolvedValue({ secondsRemaining: 120 });
    client.resetPassword.mockResolvedValue({ reset: true });

    await expect(
      service.signUp({
        email: 'user@example.com',
        password: 'Str0ng!Pass',
        language: 'en',
      }),
    ).resolves.toBe(SIGN_UP_RESPONSE);
    await expect(
      service.signOut({
        refreshToken: 'refresh-token',
        sessionId: 'session-1',
        jti: 'jti-1',
        accessTokenExpiresAt: '2026-10-24T10:15:00.000Z',
      }),
    ).resolves.toEqual({ revoked: true });
    await expect(
      service.resendVerification({ email: 'user@example.com' }),
    ).resolves.toEqual({
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
    });
    await expect(
      service.forgotPassword({ email: 'user@example.com' }),
    ).resolves.toEqual({ secondsRemaining: 120 });
    await expect(
      service.resetPassword({
        email: 'user@example.com',
        code: '123456',
        newPassword: 'N3w!Passw0rd',
      }),
    ).resolves.toEqual({ reset: true });
  });
});
