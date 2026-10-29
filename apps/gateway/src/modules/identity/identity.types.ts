import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  IDENTITY_PACKAGE_NAME,
  IDENTITY_SERVICE_NAME,
  getIdentityProtoPath,
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

export interface IdentityGrpcServiceClient extends grpc.Client {
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
  [K in keyof IdentityGrpcServiceClient]: IdentityGrpcServiceClient[K] extends (
    ...args: never[]
  ) => grpc.ClientUnaryCall
    ? K
    : never;
}[keyof IdentityGrpcServiceClient];

export interface IdentityGrpcServiceConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ): IdentityGrpcServiceClient;
}

export function identityGrpcServiceConstructor(): IdentityGrpcServiceConstructor {
  const definition = protoLoader.loadSync(getIdentityProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition);
  // `loadPackageDefinition` nests by package segment (`train.identity.v1`),
  // while the constant is the wire name. Walk the segments so a rename has one
  // source of truth rather than a matching hardcoded tree here.
  const namespace = IDENTITY_PACKAGE_NAME.split('.').reduce<
    Record<string, unknown>
  >(
    (current, part) => current[part] as Record<string, unknown>,
    loaded as unknown as Record<string, unknown>,
  );
  return namespace[
    IDENTITY_SERVICE_NAME
  ] as unknown as IdentityGrpcServiceConstructor;
}
