import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { SignUpUseCase } from './application/use-cases/sign-up.use-case.js';
import { ACCOUNT_REPOSITORY } from './application/ports/account.repository.port.js';
import { VERIFICATION_CODE_REPOSITORY } from './application/ports/verification-code.repository.port.js';
import { AccountOrmEntity } from './infrastructure/persistence/account.orm-entity.js';
import { VerificationCodeOrmEntity } from './infrastructure/persistence/verification-code.orm-entity.js';
import { TypeOrmAccountRepository } from './infrastructure/persistence/typeorm-account.repository.js';
import { TypeOrmVerificationCodeRepository } from './infrastructure/persistence/typeorm-verification-code.repository.js';
import { AccountsGrpcController } from './presentation/grpc/accounts.grpc.controller.js';

/**
 * The feature's own wiring. Ports are bound here, not in the root module, so
 * the dependency direction stays inward: application declares the interface,
 * infrastructure implements it, and only this file knows both.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AccountOrmEntity, VerificationCodeOrmEntity]),
    OutboxModule,
  ],
  controllers: [AccountsGrpcController],
  providers: [
    SignUpUseCase,
    TypeOrmAccountRepository,
    TypeOrmVerificationCodeRepository,
    { provide: ACCOUNT_REPOSITORY, useExisting: TypeOrmAccountRepository },
    {
      provide: VERIFICATION_CODE_REPOSITORY,
      useExisting: TypeOrmVerificationCodeRepository,
    },
  ],
  exports: [SignUpUseCase],
})
export class AccountsModule {}
