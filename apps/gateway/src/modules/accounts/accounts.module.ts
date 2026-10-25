import { Module } from '@nestjs/common';
import { ACCOUNTS_CLIENT } from './application/ports/accounts.port.js';
import { IdentityAccountsGrpcAdapter } from './infrastructure/grpc/identity-accounts.grpc-adapter.js';

/**
 * Transport only. The HTTP surface lives in the auth module because it owns
 * the guard, rate limits and session claims that the sign-out call needs.
 */
@Module({
  providers: [
    { provide: ACCOUNTS_CLIENT, useClass: IdentityAccountsGrpcAdapter },
  ],
  exports: [ACCOUNTS_CLIENT],
})
export class AccountsModule {}
