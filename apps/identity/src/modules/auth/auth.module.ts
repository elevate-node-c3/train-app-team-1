import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { tokenSettingsFromEnv } from '../../config/token-settings.js';
import {
  HOLD_PASSENGER_TOKEN_SETTINGS,
  holdPassengerTokenSettingsFromEnv,
} from '../../config/hold-passenger-token-settings.js';
import { AuthGrpcController } from './auth.grpc.controller.js';
import { BcryptPasswordHasher } from './bcrypt-password.hasher.js';
import {
  BOOKING_TICKET_CHECK,
  StubBookingTicketCheckAdapter,
} from './booking-ticket-check.adapter.js';
import { AccountEntity } from './entities/account.entity.js';
import { DeviceCredentialEntity } from './entities/device-credential.entity.js';
import { NationalityEntity } from './entities/nationality.entity.js';
import { PassengerEntity } from './entities/passenger.entity.js';
import { HoldPassengerTripKeyEntity } from './entities/hold-passenger-trip-key.entity.js';
import { ProfileTypeEntity } from './entities/profile-type.entity.js';
import { RefreshTokenEntity } from './entities/refresh-token.entity.js';
import { SessionEntity } from './entities/session.entity.js';
import { SignInLockoutEntity } from './entities/sign-in-lockout.entity.js';
import { VerificationCodeEntity } from './entities/verification-code.entity.js';
import { VerificationRequestEntity } from './entities/verification-request.entity.js';
import { IdentityJwtSigner } from './identity-jwt.signer.js';
import { NodeRefreshTokenHasher } from './node-refresh-token.hasher.js';
import { AccountRepository } from './repositories/account.repository.js';
import { DeviceCredentialRepository } from './repositories/device-credential.repository.js';
import { NationalityRepository } from './repositories/nationality.repository.js';
import { PassengerRepository } from './repositories/passenger.repository.js';
import { HoldPassengerTripKeyRepository } from './repositories/hold-passenger-trip-key.repository.js';
import { ProfileTypeRepository } from './repositories/profile-type.repository.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { SignInLockoutRepository } from './repositories/sign-in-lockout.repository.js';
import { VerificationCodeRepository } from './repositories/verification-code.repository.js';
import { VerificationRequestRepository } from './repositories/verification-request.repository.js';
import { AccountsService } from './services/accounts.service.js';
import { PasswordsService } from './services/passwords.service.js';
import { PassengersService } from './services/passengers.service.js';
import { HoldPassengersService } from './services/hold-passengers.service.js';
import { ProfileService } from './services/profile.service.js';
import { SessionsService } from './services/sessions.service.js';
import { SessionIssuer } from './session.issuer.js';
import { TOKEN_SETTINGS } from './token-settings.js';
import { VerificationCodeIssuer } from './verification-code.issuer.js';
import { VerificationRatePolicy } from './verification-rate.policy.js';

const ENTITIES = [
  AccountEntity,
  PassengerEntity,
  HoldPassengerTripKeyEntity,
  ProfileTypeEntity,
  NationalityEntity,
  VerificationCodeEntity,
  VerificationRequestEntity,
  SignInLockoutEntity,
  SessionEntity,
  RefreshTokenEntity,
  DeviceCredentialEntity,
];

@Module({
  imports: [TypeOrmModule.forFeature(ENTITIES), OutboxModule],
  controllers: [AuthGrpcController],
  providers: [
    AccountsService,
    SessionsService,
    PasswordsService,
    ProfileService,
    PassengersService,
    HoldPassengersService,
    VerificationCodeIssuer,
    VerificationRatePolicy,
    SessionIssuer,
    { provide: TOKEN_SETTINGS, useFactory: tokenSettingsFromEnv },
    {
      provide: HOLD_PASSENGER_TOKEN_SETTINGS,
      useFactory: holdPassengerTokenSettingsFromEnv,
    },
    { provide: BOOKING_TICKET_CHECK, useClass: StubBookingTicketCheckAdapter },
    AccountRepository,
    PassengerRepository,
    HoldPassengerTripKeyRepository,
    ProfileTypeRepository,
    NationalityRepository,
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
  exports: [AccountsService, ProfileService, PassengersService],
})
export class AuthModule {}
