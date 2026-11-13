import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { parseSessionRevokedPayload } from './session-revoked.parser.js';
import { RevocationStore } from './stores/revocation.store.js';

/** Redelivery is safe: revocation writes repeat the same keys and expiry. */
@Injectable()
export class SessionRevokedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(SessionRevokedConsumer.name);

  constructor(private readonly revocations: RevocationStore) {}

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
