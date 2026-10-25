import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type SignOutRequestDto,
  type SignOutResponseDto,
} from '@app/contracts';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import { buildSessionRevoked } from '../../domain/events/identity-events.factory.js';
import {
  DEVICE_CREDENTIAL_REPOSITORY,
  type DeviceCredentialRepositoryPort,
} from '../ports/device-credential.repository.port.js';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
} from '../ports/refresh-token.repository.port.js';
import {
  REFRESH_TOKEN_HASHER,
  type RefreshTokenHasherPort,
} from '../ports/refresh-token-hasher.port.js';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../ports/session.repository.port.js';

export interface SignOutCommand extends SignOutRequestDto {
  /** Restored from the verified gateway caller, never from the body. */
  accountId: string;
  correlationId: string;
}

/**
 * Sign-out is idempotent and strict about ownership: a session that does not
 * belong to the verified caller is left alone, and the response is still
 * `revoked: true` so an attacker cannot probe session ids.
 */
@Injectable()
export class SignOutUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(DEVICE_CREDENTIAL_REPOSITORY)
    private readonly deviceCredentials: DeviceCredentialRepositoryPort,
    @Inject(REFRESH_TOKEN_HASHER)
    private readonly tokenHasher: RefreshTokenHasherPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(command: SignOutCommand): Promise<SignOutResponseDto> {
    const now = new Date();
    const tokenHash = this.tokenHasher.hash(command.refreshToken);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const session = await this.sessions.findByIdForUpdate(
        ctx,
        command.sessionId,
      );
      if (!session || session.accountId !== command.accountId) {
        return;
      }

      if (session.revokedAt === null) {
        await this.sessions.update(
          ctx,
          session.revoke('sign_out', now),
        );
      }
      await this.refreshTokens.revokeBySession(ctx, session.id, now);

      const token = await this.refreshTokens.findByHashForUpdate(
        ctx,
        tokenHash,
      );
      if (token && token.sessionId === session.id && token.status !== 'revoked') {
        await this.refreshTokens.update(ctx, token.markRevoked(now));
      }

      await this.deviceCredentials.revokeBySession(ctx, session.id, now);

      await this.outbox.append(
        ctx,
        buildSessionRevoked({
          eventId: randomUUID(),
          correlationId: command.correlationId,
          occurredAt: now,
          accountId: session.accountId,
          sessionId: session.id,
          jti: command.jti,
          expiresAt: new Date(command.accessTokenExpiresAt),
          reason: 'sign_out',
        }),
      );
    });

    return { revoked: true };
  }
}
