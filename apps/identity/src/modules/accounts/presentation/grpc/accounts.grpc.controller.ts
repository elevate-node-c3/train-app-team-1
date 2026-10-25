import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {
  ACCOUNTS_SERVICE_NAME,
  ErrorCode,
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
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
} from '@app/contracts';
import {
  CALLER_ACCOUNT_ID_KEY,
  CALLER_JTI_KEY,
  CALLER_SESSION_ID_KEY,
  CORRELATION_ID_KEY,
  GrpcCorrelationInterceptor,
} from '@app/common';
import { AuthError } from '../../application/auth-error.js';
import { ForgotPasswordUseCase } from '../../application/use-cases/forgot-password.use-case.js';
import { RefreshUseCase } from '../../application/use-cases/refresh.use-case.js';
import { ResendVerificationUseCase } from '../../application/use-cases/resend-verification.use-case.js';
import { ResetPasswordUseCase } from '../../application/use-cases/reset-password.use-case.js';
import { SignInUseCase } from '../../application/use-cases/sign-in.use-case.js';
import { SignOutUseCase } from '../../application/use-cases/sign-out.use-case.js';
import { SignUpUseCase } from '../../application/use-cases/sign-up.use-case.js';
import { VerifyEmailUseCase } from '../../application/use-cases/verify-email.use-case.js';

/**
 * gRPC status per business code. The business code itself travels in
 * `details`; the status only tells generic gRPC clients how to categorise the
 * failure. The gateway restores the code from `details` after validating it
 * against the enum, so an unknown string can never reach a client.
 */
const GRPC_STATUS_BY_ERROR: Partial<Record<ErrorCode, grpc.status>> = {
  [ErrorCode.VALIDATION_ERROR]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.BAD_REQUEST]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.UNAUTHORIZED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.FORBIDDEN]: grpc.status.PERMISSION_DENIED,
  [ErrorCode.RESOURCE_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: grpc.status.ALREADY_EXISTS,
  [ErrorCode.EMAIL_NOT_VERIFIED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.VERIFICATION_REQUIRED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.INVALID_VERIFICATION_CODE]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.VERIFICATION_CODE_EXPIRED]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED]:
    grpc.status.RESOURCE_EXHAUSTED,
  [ErrorCode.RESEND_TOO_SOON]: grpc.status.RESOURCE_EXHAUSTED,
  [ErrorCode.INVALID_CREDENTIALS]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.ACCOUNT_LOCKED]: grpc.status.RESOURCE_EXHAUSTED,
  [ErrorCode.ACCOUNT_DISABLED]: grpc.status.PERMISSION_DENIED,
  [ErrorCode.TOKEN_EXPIRED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.TOKEN_INVALID]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.TOKEN_REVOKED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.INVALID_REFRESH_TOKEN]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.REFRESH_TOKEN_REUSE_DETECTED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.SESSION_REVOKED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.PASSWORD_REUSE]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.PASSWORD_RESET_INVALID]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.RATE_LIMITED]: grpc.status.RESOURCE_EXHAUSTED,
  [ErrorCode.PROFILE_INCOMPLETE]: grpc.status.PERMISSION_DENIED,
};

function toRpcException(error: unknown): unknown {
  if (!(error instanceof AuthError)) return error;

  return new RpcException({
    code: GRPC_STATUS_BY_ERROR[error.code] ?? grpc.status.INTERNAL,
    details: JSON.stringify({
      code: error.code,
      ...(error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    }),
    message: error.message,
  });
}

interface TokenPairWire {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

function tokenPairWire(tokens: TokenPairDto): TokenPairWire {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    accessExpiresIn: tokens.accessExpiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
  };
}

/**
 * The gRPC presentation adapter. It owns no business rule: it reads the caller
 * from CLS (restored from metadata by the interceptor), calls one use case, and
 * translates a business failure into a status plus a machine-readable detail.
 */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class AccountsGrpcController {
  constructor(
    private readonly signUpUseCase: SignUpUseCase,
    private readonly verifyEmailUseCase: VerifyEmailUseCase,
    private readonly resendVerificationUseCase: ResendVerificationUseCase,
    private readonly signInUseCase: SignInUseCase,
    private readonly refreshUseCase: RefreshUseCase,
    private readonly signOutUseCase: SignOutUseCase,
    private readonly forgotPasswordUseCase: ForgotPasswordUseCase,
    private readonly resetPasswordUseCase: ResetPasswordUseCase,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'SignUp')
  async signUp(request: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.run(() =>
      this.signUpUseCase.execute({
        email: request.email,
        password: request.password,
        language: request.language,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'VerifyEmail')
  async verifyEmail(request: VerifyEmailRequestDto): Promise<{
    tokens: TokenPairWire;
    accountId: string;
    maskedEmail: string;
  }> {
    return this.run(async () => {
      const result = await this.verifyEmailUseCase.execute({
        email: request.email,
        code: request.code,
        deviceId: request.deviceId,
        correlationId: this.correlationId(),
      });
      return {
        tokens: tokenPairWire(result),
        accountId: result.accountId,
        maskedEmail: result.maskedEmail,
      };
    });
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'ResendVerification')
  async resendVerification(
    request: ResendVerificationRequestDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.run(() =>
      this.resendVerificationUseCase.execute({
        email: request.email,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'SignIn')
  async signIn(request: SignInRequestDto): Promise<SignInResponseDto> {
    return this.run(async () => {
      const result = await this.signInUseCase.execute({
        email: request.email,
        password: request.password,
        deviceId: request.deviceId,
        correlationId: this.correlationId(),
      });
      return {
        ...result,
        tokens: result.tokens ? tokenPairWire(result.tokens) : null,
      } as SignInResponseDto;
    });
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'RefreshToken')
  async refreshToken(
    request: RefreshTokenRequestDto,
  ): Promise<{ tokens: TokenPairWire }> {
    return this.run(async () => ({
      tokens: tokenPairWire(
        await this.refreshUseCase.execute({
          refreshToken: request.refreshToken,
          correlationId: this.correlationId(),
        }),
      ),
    }));
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'SignOut')
  async signOut(request: SignOutRequestDto): Promise<SignOutResponseDto> {
    return this.run(() => {
      const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
      const sessionId = this.cls.get<string>(CALLER_SESSION_ID_KEY);
      const jti = this.cls.get<string>(CALLER_JTI_KEY);

      if (!accountId || !sessionId || !jti) {
        throw new AuthError(ErrorCode.UNAUTHORIZED);
      }

      return this.signOutUseCase.execute({
        refreshToken: request.refreshToken,
        sessionId,
        jti,
        accessTokenExpiresAt: request.accessTokenExpiresAt,
        accountId,
        correlationId: this.correlationId(),
      });
    });
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'ForgotPassword')
  async forgotPassword(
    request: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.run(() =>
      this.forgotPasswordUseCase.execute({
        email: request.email,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(ACCOUNTS_SERVICE_NAME, 'ResetPassword')
  async resetPassword(
    request: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.run(() =>
      this.resetPasswordUseCase.execute({
        email: request.email,
        code: request.code,
        newPassword: request.newPassword,
        correlationId: this.correlationId(),
      }),
    );
  }

  private correlationId(): string {
    return this.cls.get<string>(CORRELATION_ID_KEY) || randomUUID();
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
