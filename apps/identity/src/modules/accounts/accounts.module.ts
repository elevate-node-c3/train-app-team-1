import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { SignUpUseCase } from './application/use-cases/sign-up.use-case.js';
import { VerifyEmailUseCase } from './application/use-cases/verify-email.use-case.js';
import { ResendVerificationUseCase } from './application/use-cases/resend-verification.use-case.js';
import { SignInUseCase } from './application/use-cases/sign-in.use-case.js';
import { RefreshUseCase } from './application/use-cases/refresh.use-case.js';
import { SignOutUseCase } from './application/use-cases/sign-out.use-case.js';
import { ForgotPasswordUseCase } from './application/use-cases/forgot-password.use-case.js';
import { ResetPasswordUseCase } from './application/use-cases/reset-password.use-case.js';
import { SessionIssuer } from './application/services/session.issuer.js';
import { VerificationCodeIssuer } from './application/services/verification-code.issuer.js';
import { VerificationRatePolicy } from './application/services/verification-rate.policy.js';
import { TOKEN_SETTINGS } from './application/token-settings.js';
import { tokenSettingsFromEnv } from '../../config/token-settings.js';
import { ACCOUNT_REPOSITORY } from './application/ports/account.repository.port.js';
import { ACCESS_TOKEN_SIGNER } from './application/ports/access-token-signer.port.js';
import { DEVICE_CREDENTIAL_REPOSITORY } from './application/ports/device-credential.repository.port.js';
import { PASSWORD_HASHER } from './application/ports/password-hasher.port.js';
import { REFRESH_TOKEN_REPOSITORY } from './application/ports/refresh-token.repository.port.js';
import { REFRESH_TOKEN_HASHER } from './application/ports/refresh-token-hasher.port.js';
import { SESSION_REPOSITORY } from './application/ports/session.repository.port.js';
import { SIGN_IN_LOCKOUT_REPOSITORY } from './application/ports/sign-in-lockout.repository.port.js';
import { VERIFICATION_CODE_REPOSITORY } from './application/ports/verification-code.repository.port.js';
import { VERIFICATION_REQUEST_REPOSITORY } from './application/ports/verification-request.repository.port.js';
import { AccountOrmEntity } from './infrastructure/persistence/account.orm-entity.js';
import { DeviceCredentialOrmEntity } from './infrastructure/persistence/device-credential.orm-entity.js';
import { RefreshTokenOrmEntity } from './infrastructure/persistence/refresh-token.orm-entity.js';
import { SessionOrmEntity } from './infrastructure/persistence/session.orm-entity.js';
import { SignInLockoutOrmEntity } from './infrastructure/persistence/sign-in-lockout.orm-entity.js';
import { VerificationCodeOrmEntity } from './infrastructure/persistence/verification-code.orm-entity.js';
import { VerificationRequestOrmEntity } from './infrastructure/persistence/verification-request.orm-entity.js';
import { TypeOrmAccountRepository } from './infrastructure/persistence/typeorm-account.repository.js';
import { TypeOrmDeviceCredentialRepository } from './infrastructure/persistence/typeorm-device-credential.repository.js';
import { TypeOrmRefreshTokenRepository } from './infrastructure/persistence/typeorm-refresh-token.repository.js';
import { TypeOrmSessionRepository } from './infrastructure/persistence/typeorm-session.repository.js';
import { TypeOrmSignInLockoutRepository } from './infrastructure/persistence/typeorm-sign-in-lockout.repository.js';
import { TypeOrmVerificationCodeRepository } from './infrastructure/persistence/typeorm-verification-code.repository.js';
import { TypeOrmVerificationRequestRepository } from './infrastructure/persistence/typeorm-verification-request.repository.js';
import { BcryptPasswordHasher } from './infrastructure/security/bcrypt-password.hasher.js';
import { IdentityJwtSigner } from './infrastructure/security/identity-jwt.signer.js';
import { NodeRefreshTokenHasher } from './infrastructure/security/node-refresh-token.hasher.js';
import { AccountsGrpcController } from './presentation/grpc/accounts.grpc.controller.js';

const ORM_ENTITIES = [
  AccountOrmEntity,
  VerificationCodeOrmEntity,
  VerificationRequestOrmEntity,
  SignInLockoutOrmEntity,
  SessionOrmEntity,
  RefreshTokenOrmEntity,
  DeviceCredentialOrmEntity,
];

/**
 * The feature's own wiring. Ports are bound here, not in the root module, so
 * the dependency direction stays inward: application declares the interface,
 * infrastructure implements it, and only this file knows both.
 */
@Module({
  imports: [TypeOrmModule.forFeature(ORM_ENTITIES), OutboxModule],
  controllers: [AccountsGrpcController],
  providers: [
    SignUpUseCase,
    VerifyEmailUseCase,
    ResendVerificationUseCase,
    SignInUseCase,
    RefreshUseCase,
    SignOutUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    VerificationCodeIssuer,
    VerificationRatePolicy,
    SessionIssuer,
    { provide: TOKEN_SETTINGS, useFactory: tokenSettingsFromEnv },
    TypeOrmAccountRepository,
    TypeOrmVerificationCodeRepository,
    TypeOrmVerificationRequestRepository,
    TypeOrmSignInLockoutRepository,
    TypeOrmSessionRepository,
    TypeOrmRefreshTokenRepository,
    TypeOrmDeviceCredentialRepository,
    BcryptPasswordHasher,
    IdentityJwtSigner,
    NodeRefreshTokenHasher,
    { provide: ACCOUNT_REPOSITORY, useExisting: TypeOrmAccountRepository },
    {
      provide: VERIFICATION_CODE_REPOSITORY,
      useExisting: TypeOrmVerificationCodeRepository,
    },
    {
      provide: VERIFICATION_REQUEST_REPOSITORY,
      useExisting: TypeOrmVerificationRequestRepository,
    },
    {
      provide: SIGN_IN_LOCKOUT_REPOSITORY,
      useExisting: TypeOrmSignInLockoutRepository,
    },
    { provide: SESSION_REPOSITORY, useExisting: TypeOrmSessionRepository },
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      useExisting: TypeOrmRefreshTokenRepository,
    },
    {
      provide: DEVICE_CREDENTIAL_REPOSITORY,
      useExisting: TypeOrmDeviceCredentialRepository,
    },
    { provide: PASSWORD_HASHER, useExisting: BcryptPasswordHasher },
    { provide: REFRESH_TOKEN_HASHER, useExisting: NodeRefreshTokenHasher },
    { provide: ACCESS_TOKEN_SIGNER, useExisting: IdentityJwtSigner },
  ],
  exports: [SignUpUseCase],
})
export class AccountsModule {}
