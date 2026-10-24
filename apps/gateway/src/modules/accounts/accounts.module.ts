import { Module } from '@nestjs/common';
import { ACCOUNTS_CLIENT } from './application/ports/accounts.port.js';
import { IdentityAccountsGrpcAdapter } from './infrastructure/grpc/identity-accounts.grpc-adapter.js';
import { AccountsHttpController } from './presentation/http/accounts.http.controller.js';

@Module({
  controllers: [AccountsHttpController],
  providers: [
    { provide: ACCOUNTS_CLIENT, useClass: IdentityAccountsGrpcAdapter },
  ],
})
export class AccountsModule {}
