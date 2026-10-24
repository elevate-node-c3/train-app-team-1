import { Module } from '@nestjs/common';
import { ACCOUNTS_CLIENT } from './application/ports/accounts.port.js';
import { SignUpUseCase } from './application/use-cases/sign-up.use-case.js';
import { IdentityAccountsGrpcAdapter } from './infrastructure/grpc/identity-accounts.grpc-adapter.js';
import { AccountsHttpController } from './presentation/http/accounts.http.controller.js';

@Module({
  controllers: [AccountsHttpController],
  providers: [
    SignUpUseCase,
    { provide: ACCOUNTS_CLIENT, useClass: IdentityAccountsGrpcAdapter },
  ],
})
export class AccountsModule {}
