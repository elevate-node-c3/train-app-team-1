import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { tokenSettingsFromEnv } from '../../config/token-settings.js';
import { AuthGrpcController } from './auth.grpc.controller.js';
import { BcryptPasswordHasher } from './bcrypt-password.hasher.js';
import { AccountEntity } from './entities/account.entity.js';
import { DeviceCredentialEntity } from './entities/device-credential.entity.js';
import { RefreshTokenEntity } from './entities/refresh-token.entity.js';
import { SessionEntity } from './entities/session.entity.js';
import { SignInLockoutEntity } from './entities/sign-in-lockout.entity.js';
import { VerificationCodeEntity } from './entities/verification-code.entity.js';
import { VerificationRequestEntity } from './entities/verification-request.entity.js';
import { IdentityJwtSigner } from './identity-jwt.signer.js';
import { NodeRefreshTokenHasher } from './node-refresh-token.hasher.js';
import { AccountRepository } from './repositories/account.repository.js';
import { DeviceCredentialRepository } from './repositories/device-credential.repository.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { SignInLockoutRepository } from './repositories/sign-in-lockout.repository.js';
import { VerificationCodeRepository } from './repositories/verification-code.repository.js';
import { VerificationRequestRepository } from './repositories/verification-request.repository.js';
import { AccountsService } from './services/accounts.service.js';
import { PasswordsService } from './services/passwords.service.js';
import { SessionsService } from './services/sessions.service.js';
import { SessionIssuer } from './session.issuer.js';
import { TOKEN_SETTINGS } from './token-settings.js';
import { VerificationCodeIssuer } from './verification-code.issuer.js';
import { VerificationRatePolicy } from './verification-rate.policy.js';

const ENTITIES = [
  AccountEntity,
  VerificationCodeEntity,
  VerificationRequestEntity,
  SignInLockoutEntity,
  SessionEntity,
  RefreshTokenEntity,
  DeviceCredentialEntity,
];

/**
 * The auth feature's own wiring. Concrete repositories and helpers are the
 * provider tokens; only the validated token settings still need a symbol.
 */
@Module({
  imports: [TypeOrmModule.forFeature(ENTITIES), OutboxModule],
  controllers: [AuthGrpcController],
  providers: [
    AccountsService,
    SessionsService,
    PasswordsService,
    VerificationCodeIssuer,
    VerificationRatePolicy,
    SessionIssuer,
    { provide: TOKEN_SETTINGS, useFactory: tokenSettingsFromEnv },
    AccountRepository,
    VerificationCodeRepository,
    VerificationRequestRepository,
    SignInLockoutRepository,
    SessionRepository,
    RefreshTokenRepository,
    DeviceCredentialRepository,
    BcryptPasswordHasher,
    IdentityJwtSigner,
    NodeRefreshTokenHasher,
  ],
  exports: [AccountsService],
})
export class AuthModule {}
