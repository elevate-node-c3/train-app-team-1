import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
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
  type ResolveHoldPassengersRequest,
  type ResolveHoldPassengersResponse,
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
  toRpcException,
} from '@app/common';
import { matchesServiceCredential } from '@app/common/grpc/service-credential.js';
import { AuthError } from './auth-error.js';
import { AccountsService } from './services/accounts.service.js';
import { PasswordsService } from './services/passwords.service.js';
import { ProfileService } from './services/profile.service.js';
import { SessionsService } from './services/sessions.service.js';
import { PassengersService } from './services/passengers.service.js';
import { HoldPassengersService } from './services/hold-passengers.service.js';

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
 * Read the caller from CLS metadata and leave auth rules to the services.
 * Translate business errors into gRPC status and details.
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
    private readonly holdPassengers: HoldPassengersService,
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

  @GrpcMethod(IDENTITY_SERVICE_NAME, 'ResolveHoldPassengers')
  async resolveHoldPassengers(
    request: ResolveHoldPassengersRequest,
    metadata?: grpc.Metadata,
  ): Promise<ResolveHoldPassengersResponse> {
    return this.run(async () => {
      const keys = metadata?.get('x-booking-identity-key');
      if (
        keys?.length !== 1 ||
        !matchesServiceCredential(
          keys[0],
          process.env.BOOKING_IDENTITY_SERVICE_KEY,
        )
      ) {
        throw new AuthError(ErrorCode.UNAUTHORIZED);
      }
      try {
        return await this.holdPassengers.resolve(request);
      } catch (error: unknown) {
        throw new AuthError(
          error instanceof AuthError
            ? error.code
            : ErrorCode.SERVICE_UNAVAILABLE,
        );
      }
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
