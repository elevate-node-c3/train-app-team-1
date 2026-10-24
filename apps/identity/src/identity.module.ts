import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule, DOMAIN_EVENT_PUBLISHER } from '@app/contracts';
import { AmqpEventPublisher, MessagingModule } from '@app/messaging';
import { IdentityController } from './transport/identity.controller.js';
import { AuthController } from './transport/auth.controller.js';
import { IdentityService } from './domain/identity.service.js';
import { IdentityEvents } from './domain/identity-events.js';
import { PasswordRecoveryService } from './domain/password-recovery.service.js';
import { SignInService } from './domain/sign-in.service.js';
import { IdentityRepository } from './persistence/identity.repository.js';
import { IdentityRedisService } from './persistence/identity-redis.service.js';
import { AccountRepository } from './persistence/account.repository.js';
import { OneTimeCodeRepository } from './persistence/one-time-code.repository.js';
import { SignInAttemptStore } from './persistence/sign-in-attempt.store.js';
import { AccountEntity } from './persistence/entities/account.entity.js';
import { OneTimeCodeEntity } from './persistence/entities/one-time-code.entity.js';

/**
 * SESSION_SERVICE and ACCOUNT_REVOCATION_SERVICE (Member 2) and
 * VERIFICATION_CODE_ISSUER (AUTH-2) are not provided here. Identity starts
 * once the modules implementing them are imported.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    TypeOrmModule.forFeature([AccountEntity, OneTimeCodeEntity]),
    CommonModule,
    ContractsModule,
    MessagingModule,
  ],
  controllers: [IdentityController, AuthController],
  providers: [
    IdentityService,
    IdentityRepository,
    IdentityRedisService,
    AccountRepository,
    OneTimeCodeRepository,
    SignInAttemptStore,
    IdentityEvents,
    SignInService,
    PasswordRecoveryService,
    { provide: DOMAIN_EVENT_PUBLISHER, useExisting: AmqpEventPublisher },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
