import { Injectable, Logger } from '@nestjs/common';
import type { SessionRevokedPayloadV1 } from '@app/contracts';
import { RedisClientService } from '@app/common';
import type {
  RevocationStorePort,
  RevocationSubject,
} from '../../application/ports/revocation-store.port.js';

interface MemoryEntry {
  expiresAt: number;
  /** Present for the account-wide marker only. */
  revokedAt?: number;
}

const JTI_PREFIX = 'auth:revoked:jti:';
const SID_PREFIX = 'auth:revoked:sid:';
const ACCOUNT_PREFIX = 'auth:revoked:account:';

/**
 * Revocation markers live in Redis so every gateway instance sees them, and in
 * process memory so a Redis outage does not silently un-revoke a token this
 * instance already knows about.
 *
 * Redis being down is a deliberate fail-open: an unavailable cache must not
 * take the whole API down. The degraded readiness report is the honest signal,
 * and access tokens are short-lived enough that the exposure is bounded.
 */
@Injectable()
export class RevocationStore implements RevocationStorePort {
  private readonly logger = new Logger(RevocationStore.name);
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(private readonly redis: RedisClientService) {}

  async isRevoked(subject: RevocationSubject): Promise<boolean> {
    const now = Date.now();
    this.prune(now);

    if (this.memory.has(`${JTI_PREFIX}${subject.jti}`)) return true;
    if (this.memory.has(`${SID_PREFIX}${subject.sid}`)) return true;

    const account = this.memory.get(`${ACCOUNT_PREFIX}${subject.sub}`);
    if (account?.revokedAt !== undefined) {
      if (subject.iat * 1000 <= account.revokedAt) return true;
    }

    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return false;

    try {
      const [jti, sid, accountMarker] = await client.mget(
        `${JTI_PREFIX}${subject.jti}`,
        `${SID_PREFIX}${subject.sid}`,
        `${ACCOUNT_PREFIX}${subject.sub}`,
      );
      if (jti !== null || sid !== null) return true;
      if (accountMarker !== null) {
        const revokedAt = Number(accountMarker);
        if (Number.isFinite(revokedAt) && subject.iat * 1000 <= revokedAt) {
          return true;
        }
      }
      return false;
    } catch (error: unknown) {
      this.logger.warn(
        `Revocation lookup failed; allowing the token in degraded mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async revoke(payload: SessionRevokedPayloadV1): Promise<void> {
    const now = Date.now();
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return;
    }

    const ttlMs = Math.max(1, expiresAt - now);
    const revokedAt = Date.parse(payload.revokedAt);

    const write = (key: string, entry: MemoryEntry): void => {
      this.memory.set(key, entry);
      this.prune(now);
    };

    if (payload.sessionId) {
      write(`${SID_PREFIX}${payload.sessionId}`, { expiresAt });
    }
    if (payload.jti) {
      write(`${JTI_PREFIX}${payload.jti}`, { expiresAt });
    }
    if (payload.allSessions) {
      write(`${ACCOUNT_PREFIX}${payload.accountId}`, {
        expiresAt,
        revokedAt: Number.isFinite(revokedAt) ? revokedAt : now,
      });
    }

    const client = this.redis.isAvailable() ? this.redis.getClient() : null;
    if (!client) return;

    try {
      const pipeline = client.pipeline();
      if (payload.sessionId) {
        pipeline.set(`${SID_PREFIX}${payload.sessionId}`, '1', 'PX', ttlMs);
      }
      if (payload.jti) {
        pipeline.set(`${JTI_PREFIX}${payload.jti}`, '1', 'PX', ttlMs);
      }
      if (payload.allSessions) {
        pipeline.set(
          `${ACCOUNT_PREFIX}${payload.accountId}`,
          String(Number.isFinite(revokedAt) ? revokedAt : now),
          'PX',
          ttlMs,
        );
      }
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.warn(
        `Could not persist revocation markers to Redis; this instance remains protected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
  }
}
