import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import * as grpc from '@grpc/grpc-js';
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR_CODE,
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
  type RefreshResponseDto,
  type RefreshTokenRequestDto,
  type ResendVerificationRequestDto,
  type ResendVerificationResponseDto,
  type ResetPasswordRequestDto,
  type ResetPasswordResponseDto,
  type SignInRequestDto,
  type SignInResponseDto,
  type SignOutRequestDto,
  type SignOutResponseDto,
  type SignUpRequestDto,
  type SignUpResponseDto,
  type TokenPairDto,
  type VerifyEmailRequestDto,
  type VerifyEmailResponseDto,
} from '@app/contracts';
import {
  createGrpcMetadataWithCaller,
  grpcStatusException,
} from '@app/common';
import type { AccountsClientPort } from '../../application/ports/accounts.port.js';
import {
  accountsServiceConstructor,
  type AccountsServiceClient,
  type UnaryMethod,
  type VerifyEmailWireResponse,
  type WireRefreshResponse,
  type WireSignInResponse,
  type WireTokenPair,
} from './identity-accounts.wire.js';

/** The HTTP request must not hang longer than this on identity. */
export const ACCOUNTS_CALL_TIMEOUT_MS = 2500;

type Callback<T> = (error: grpc.ServiceError | null, response?: T) => void;

function toTokenPair(tokens: WireTokenPair): TokenPairDto {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    accessExpiresIn: tokens.accessExpiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
  };
}

/**
 * The one adapter between HTTP and identity's gRPC contract.
 *
 * A business failure arrives as a gRPC status plus a JSON `details` string.
 * The details are trusted only when they name a known `ErrorCode`; anything
 * else falls back to the generic status mapping, so an internal message never
 * becomes a client-visible code.
 */
@Injectable()
export class IdentityAccountsGrpcAdapter
  implements AccountsClientPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IdentityAccountsGrpcAdapter.name);
  private client: AccountsServiceClient | null = null;

  constructor(private readonly cls: ClsService) {}

  onModuleInit(): void {
    try {
      const Service = accountsServiceConstructor();
      const url = process.env.IDENTITY_GRPC_URL || 'identity:50051';
      this.client = new Service(url, grpc.credentials.createInsecure());
      this.logger.log(`Connected accounts client to ${url}`);
    } catch (error: unknown) {
      // Degrade, don't crash: the readiness probe and the 503 below are the
      // honest signals. A bad URL should not take the whole gateway down.
      this.logger.warn(
        `Failed to initialize identity accounts client: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  onModuleDestroy(): void {
    this.client?.close();
    this.client = null;
  }

  signUp(input: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.unary('signUp', {
      email: input.email,
      password: input.password,
      language: input.language ?? '',
    });
  }

  async verifyEmail(
    input: VerifyEmailRequestDto,
  ): Promise<VerifyEmailResponseDto> {
    const response = await this.unary<VerifyEmailWireResponse>('verifyEmail', {
      email: input.email,
      code: input.code,
      deviceId: input.deviceId ?? '',
    });
    if (!response.tokens) {
      throw new InternalServerErrorException('identity returned no token pair');
    }
    return {
      ...toTokenPair(response.tokens),
      accountId: response.accountId,
      maskedEmail: response.maskedEmail,
    };
  }

  resendVerification(
    input: ResendVerificationRequestDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.unary('resendVerification', { email: input.email });
  }

  async signIn(input: SignInRequestDto): Promise<SignInResponseDto> {
    const response = await this.unary<WireSignInResponse>('signIn', {
      email: input.email,
      password: input.password,
      deviceId: input.deviceId ?? '',
    });
    return {
      verificationRequired: response.verificationRequired,
      maskedEmail: response.maskedEmail,
      secondsRemaining: response.secondsRemaining,
      tokens: response.tokens ? toTokenPair(response.tokens) : null,
    };
  }

  async refreshToken(
    input: RefreshTokenRequestDto,
  ): Promise<RefreshResponseDto> {
    const response = await this.unary<WireRefreshResponse>('refreshToken', {
      refreshToken: input.refreshToken,
    });
    if (!response.tokens) {
      throw new InternalServerErrorException('identity returned no token pair');
    }
    return toTokenPair(response.tokens);
  }

  signOut(input: SignOutRequestDto): Promise<SignOutResponseDto> {
    return this.unary('signOut', {
      refreshToken: input.refreshToken,
      sessionId: input.sessionId,
      jti: input.jti,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
    });
  }

  forgotPassword(
    input: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.unary('forgotPassword', { email: input.email });
  }

  resetPassword(
    input: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.unary('resetPassword', {
      email: input.email,
      code: input.code,
      newPassword: input.newPassword,
    });
  }

  private unary<TResponse>(
    method: UnaryMethod,
    request: object,
  ): Promise<TResponse> {
    const client = this.client;
    if (!client) {
      return Promise.reject(
        new ServiceUnavailableException('identity is unavailable'),
      );
    }

    const metadata = createGrpcMetadataWithCaller(this.cls);
    const deadline = Date.now() + ACCOUNTS_CALL_TIMEOUT_MS;
    const invoke = client[method] as unknown as (
      req: object,
      md: grpc.Metadata,
      options: grpc.CallOptions,
      callback: Callback<TResponse>,
    ) => grpc.ClientUnaryCall;

    return new Promise<TResponse>((resolve, reject) => {
      invoke.call(
        client,
        request,
        metadata,
        { deadline },
        (error, response) => {
          if (!error) {
            if (!response) {
              reject(
                new InternalServerErrorException(
                  'identity returned an empty response',
                ),
              );
              return;
            }
            resolve(response);
            return;
          }
          reject(this.exceptionFor(error));
        },
      );
    });
  }

  private exceptionFor(error: grpc.ServiceError): HttpException {
    const explicit = this.parseBusinessError(error.details);
    if (explicit) {
      return new HttpException(
        {
          code: explicit.code,
          ...(explicit.retryAfterSeconds
            ? { retryAfterSeconds: explicit.retryAfterSeconds }
            : {}),
        },
        HTTP_STATUS_BY_ERROR_CODE[explicit.code] ??
          HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (
      error.code === grpc.status.UNAVAILABLE ||
      error.code === grpc.status.DEADLINE_EXCEEDED
    ) {
      this.logger.warn(
        `identity call failed with gRPC status ${error.code}: ${error.message}`,
      );
    }
    return grpcStatusException(error.code);
  }

  private parseBusinessError(
    details: unknown,
  ): { code: ErrorCode; retryAfterSeconds?: number } | null {
    if (typeof details !== 'string' || details.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(details);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.code !== 'string' ||
        !Object.values(ErrorCode).includes(record.code as ErrorCode)
      ) {
        return null;
      }
      const retry = record.retryAfterSeconds;
      return {
        code: record.code as ErrorCode,
        ...(typeof retry === 'number' &&
        Number.isFinite(retry) &&
        retry > 0
          ? { retryAfterSeconds: Math.ceil(retry) }
          : {}),
      };
    } catch {
      return null;
    }
  }
}
