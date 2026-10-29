import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';

/**
 * Device PIN credentials live in this schema but no endpoint creates one yet.
 * The only operation the auth flows need is revocation: a password reset or a
 * session reuse must not leave a PIN usable on a stolen phone.
 */
@Injectable()
export class DeviceCredentialRepository {
  async revokeBySession(
    ctx: TransactionContext,
    sessionId: string,
    at: Date,
  ): Promise<void> {
    await entityManagerOf(ctx).query(
      `
        UPDATE device_credential
           SET revoked_at = $2
         WHERE session_id = $1
           AND revoked_at IS NULL
      `,
      [sessionId, at],
    );
  }

  async revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    at: Date,
  ): Promise<void> {
    await entityManagerOf(ctx).query(
      `
        UPDATE device_credential
           SET revoked_at = $2
         WHERE account_id = $1
           AND revoked_at IS NULL
      `,
      [accountId, at],
    );
  }
}
