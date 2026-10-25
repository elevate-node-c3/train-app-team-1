import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

export const DEVICE_CREDENTIAL_REPOSITORY = Symbol(
  'DEVICE_CREDENTIAL_REPOSITORY',
);

export interface DeviceCredentialRepositoryPort {
  revokeBySession(
    ctx: TransactionContext,
    sessionId: string,
    at: Date,
  ): Promise<void>;
  revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    at: Date,
  ): Promise<void>;
}
