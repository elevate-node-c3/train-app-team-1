import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { parseSessionRevokedPayload } from '../session-revoked.parser.js';
import {
  REVOCATION_STORE,
  type RevocationStorePort,
} from '../ports/revocation-store.port.js';

/**
 * Writes the gateway's revocation markers. The side effect is idempotent: a
 * redelivered event sets the same keys with the same TTLs, so the consumer's
 * at-least-once contract is safe here without extra bookkeeping.
 */
@Injectable()
export class HandleSessionRevokedUseCase implements EventHandlerPort {
  private readonly logger = new Logger(HandleSessionRevokedUseCase.name);

  constructor(
    @Inject(REVOCATION_STORE)
    private readonly revocations: RevocationStorePort,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseSessionRevokedPayload(envelope);
    if (Date.parse(payload.expiresAt) <= Date.now()) {
      this.logger.debug(
        `Session revocation for ${payload.accountId} arrived after token expiry; skipping`,
      );
      return { status: 'skipped', skipReason: 'expired' };
    }

    await this.revocations.revoke(payload);
    return { status: 'handled' };
  }
}
