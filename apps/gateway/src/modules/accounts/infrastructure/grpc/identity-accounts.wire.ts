import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  ACCOUNTS_SERVICE_NAME,
  getAccountsProtoPath,
  type ForgotPasswordResponseDto,
  type ResendVerificationResponseDto,
  type ResetPasswordResponseDto,
  type SignOutResponseDto,
  type SignUpResponseDto,
} from '@app/contracts';

export interface WireTokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

export interface WireSignInResponse {
  verificationRequired: boolean;
  maskedEmail: string;
  secondsRemaining: number;
  tokens?: WireTokenPair;
}

export interface WireRefreshResponse {
  tokens?: WireTokenPair;
}

/** Identity's wire-level verification result, before the edge flattens it. */
export interface VerifyEmailWireResponse {
  tokens: WireTokenPair;
  accountId: string;
  maskedEmail: string;
}

type Callback<T> = (error: grpc.ServiceError | null, response?: T) => void;

export interface AccountsServiceClient extends grpc.Client {
  signUp(
    request: { email: string; password: string; language: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<SignUpResponseDto>,
  ): grpc.ClientUnaryCall;
  verifyEmail(
    request: { email: string; code: string; deviceId: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<VerifyEmailWireResponse>,
  ): grpc.ClientUnaryCall;
  resendVerification(
    request: { email: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<ResendVerificationResponseDto>,
  ): grpc.ClientUnaryCall;
  signIn(
    request: { email: string; password: string; deviceId: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<WireSignInResponse>,
  ): grpc.ClientUnaryCall;
  refreshToken(
    request: { refreshToken: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<WireRefreshResponse>,
  ): grpc.ClientUnaryCall;
  signOut(
    request: {
      refreshToken: string;
      sessionId: string;
      jti: string;
      accessTokenExpiresAt: string;
    },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<SignOutResponseDto>,
  ): grpc.ClientUnaryCall;
  forgotPassword(
    request: { email: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<ForgotPasswordResponseDto>,
  ): grpc.ClientUnaryCall;
  resetPassword(
    request: { email: string; code: string; newPassword: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: Callback<ResetPasswordResponseDto>,
  ): grpc.ClientUnaryCall;
}

export type UnaryMethod = {
  [K in keyof AccountsServiceClient]: AccountsServiceClient[K] extends (
    ...args: never[]
  ) => grpc.ClientUnaryCall
    ? K
    : never;
}[keyof AccountsServiceClient];

export interface AccountsServiceConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ): AccountsServiceClient;
}

export function accountsServiceConstructor(): AccountsServiceConstructor {
  const definition = protoLoader.loadSync(getAccountsProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    train: {
      accounts: {
        v1: Record<string, AccountsServiceConstructor>;
      };
    };
  };
  return loaded.train.accounts.v1[ACCOUNTS_SERVICE_NAME];
}
