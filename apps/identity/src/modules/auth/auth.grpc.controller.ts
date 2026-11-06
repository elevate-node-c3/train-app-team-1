import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {
  IDENTITY_SERVICE_NAME,
  ErrorCode,
  type CompleteProfileRequestDto,
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
  type PassengerDto,
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
import { AuthError } from './auth-error.js';
import { AccountsService } from './services/accounts.service.js';
import { PasswordsService } from './services/passwords.service.js';
import { ProfileService } from './services/profile.service.js';
import { SessionsService } from './services/sessions.service.js';
import { PassengersService } from './services/passengers.service.js';

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

  // Profile completion
  [ErrorCode.PROFILE_ALREADY_COMPLETE]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.INVALID_FULL_NAME]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_NATIONAL_ID_LENGTH]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_NATIONAL_ID_CENTURY]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.NATIONAL_ID_ALREADY_REGISTERED]: grpc.status.ALREADY_EXISTS,
  [ErrorCode.INVALID_PHONE_FORMAT]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.PHONE_ALREADY_REGISTERED]: grpc.status.ALREADY_EXISTS,
  [ErrorCode.INVALID_PROFILE_TYPE]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_NATIONALITY]: grpc.status.INVALID_ARGUMENT,

  // Saved passengers
  [ErrorCode.PASSENGER_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.PASSENGER_LIMIT_REACHED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.CANNOT_DELETE_SELF_PASSENGER]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.NATIONAL_ID_LOCKED]: grpc.status.FAILED_PRECONDITION,
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

interface ProfileWire {
  accountId: string;
  fullName: string;
  phoneNumber: string;
  nationalId: string;
  profileType: string;
  nationality: string;
  bookable: boolean;
}

interface ListPassengersRequestWire {
  accountId: string;
  language?: string;
}

interface AddPassengerRequestWire {
  accountId: string;
  fullName: string;
  nationalId: string;
  profileType: string;
  language?: string;
}

interface UpdatePassengerRequestWire {
  passengerId: string;
  accountId: string;
  fullName: string;
  nationalId: string;
  profileType: string;
  language?: string;
}

interface DeletePassengerRequestWire {
  passengerId: string;
  accountId: string;
}

/**
 * The gRPC transport adapter. It owns no business rule: it reads the caller
 * from CLS (restored from metadata by the interceptor), calls one service, and
 * translates a business failure into a status plus a machine-readable detail.
 */
@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class AuthGrpcController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    private readonly passwords: PasswordsService,
    private readonly profiles: ProfileService,
    private readonly passengers: PassengersService,
    private readonly cls: ClsService,
  ) {}

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'SignUp')
  async signUp(request: SignUpRequestDto): Promise<SignUpResponseDto> {
    return this.run(() =>
      this.accounts.signUp({
        email: request.email,
        password: request.password,
        language: request.language,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'VerifyEmail')
  async verifyEmail(request: VerifyEmailRequestDto): Promise<{
    tokens: TokenPairWire;
    accountId: string;
    maskedEmail: string;
  }> {
    return this.run(async () => {
      const result = await this.accounts.verifyEmail({
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

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'ResendVerification')
  async resendVerification(
    request: ResendVerificationRequestDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.run(() =>
      this.accounts.resendVerification({
        email: request.email,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'SignIn')
  async signIn(request: SignInRequestDto): Promise<SignInResponseDto> {
    return this.run(async () => {
      const result = await this.sessions.signIn({
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

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'RefreshToken')
  async refreshToken(
    request: RefreshTokenRequestDto,
  ): Promise<{ tokens: TokenPairWire }> {
    return this.run(async () => ({
      tokens: tokenPairWire(
        await this.sessions.refresh({
          refreshToken: request.refreshToken,
          correlationId: this.correlationId(),
        }),
      ),
    }));
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'SignOut')
  async signOut(request: SignOutRequestDto): Promise<SignOutResponseDto> {
    return this.run(() => {
      const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
      const sessionId = this.cls.get<string>(CALLER_SESSION_ID_KEY);
      const jti = this.cls.get<string>(CALLER_JTI_KEY);

      if (!accountId || !sessionId || !jti) {
        throw new AuthError(ErrorCode.UNAUTHORIZED);
      }

      return this.sessions.signOut({
        refreshToken: request.refreshToken,
        sessionId,
        jti,
        accessTokenExpiresAt: request.accessTokenExpiresAt,
        accountId,
        correlationId: this.correlationId(),
      });
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'ForgotPassword')
  async forgotPassword(
    request: ForgotPasswordRequestDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.run(() =>
      this.passwords.forgotPassword({
        email: request.email,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'ResetPassword')
  async resetPassword(
    request: ResetPasswordRequestDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.run(() =>
      this.passwords.resetPassword({
        email: request.email,
        code: request.code,
        newPassword: request.newPassword,
        correlationId: this.correlationId(),
      }),
    );
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'CompleteProfile')
  async completeProfile(request: CompleteProfileRequestDto): Promise<{
    tokens: TokenPairWire;
    profile: ProfileWire;
  }> {
    return this.run(async () => {
      const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
      if (!accountId) {
        throw new AuthError(ErrorCode.UNAUTHORIZED);
      }

      const result = await this.profiles.completeProfile({
        accountId,
        correlationId: this.correlationId(),
        fullName: request.fullName,
        phoneNumber: request.phoneNumber,
        nationalId: request.nationalId,
        profileType: request.profileType,
        nationality: request.nationality,
      });

      return {
        tokens: tokenPairWire(result.tokens),
        profile: {
          accountId: result.profile.accountId,
          fullName: result.profile.fullName ?? '',
          phoneNumber: result.profile.phoneNumber ?? '',
          nationalId: result.profile.nationalId ?? '',
          profileType: result.profile.profileType ?? '',
          nationality: result.profile.nationality ?? '',
          bookable: result.profile.bookable,
        },
      };
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'GetProfile')
  async getProfile(): Promise<{ profile: ProfileWire }> {
    return this.run(async () => {
      const accountId = this.cls.get<string>(CALLER_ACCOUNT_ID_KEY);
      if (!accountId) {
        throw new AuthError(ErrorCode.UNAUTHORIZED);
      }

      const profile = await this.profiles.getProfile(accountId);

      return {
        profile: {
          accountId: profile.accountId,
          fullName: profile.fullName ?? '',
          phoneNumber: profile.phoneNumber ?? '',
          nationalId: profile.nationalId ?? '',
          profileType: profile.profileType ?? '',
          nationality: profile.nationality ?? '',
          bookable: profile.bookable,
        },
      };
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'GetProfileOptions')
  async getProfileOptions(): Promise<{
    profileTypes: { code: string; nameAr: string; nameEn: string }[];
    nationalities: { code: string; nameAr: string; nameEn: string }[];
  }> {
    return this.run(async () => {
      return this.profiles.getProfileOptions();
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'ListPassengers')
  async listPassengers(
    request: ListPassengersRequestWire,
  ): Promise<{ passengers: PassengerDto[] }> {
    return this.run(async () => {
      const passengers = await this.passengers.listPassengers(
        request.accountId,
        request.language,
      );
      return { passengers };
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'AddPassenger')
  async addPassenger(
    request: AddPassengerRequestWire,
  ): Promise<{ passenger: PassengerDto }> {
    return this.run(async () => {
      const passenger = await this.passengers.addPassenger(request);
      return { passenger };
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'UpdatePassenger')
  async updatePassenger(
    request: UpdatePassengerRequestWire,
  ): Promise<{ passenger: PassengerDto }> {
    return this.run(async () => {
      const passenger = await this.passengers.updatePassenger(request);
      return { passenger };
    });
  }

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'DeletePassenger')
  async deletePassenger(
    request: DeletePassengerRequestWire,
  ): Promise<{ success: boolean }> {
    return this.run(async () => {
      await this.passengers.deletePassenger(request);
      return { success: true };
    });
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
