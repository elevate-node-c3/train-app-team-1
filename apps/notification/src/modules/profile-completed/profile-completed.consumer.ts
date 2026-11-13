import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { parseProfileCompletedPayload } from './profile-completed.parser.js';
import { TravellerProfileRepository } from './traveller-profile.repository.js';

@Injectable()
export class ProfileCompletedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(ProfileCompletedConsumer.name);

  constructor(private readonly travellers: TravellerProfileRepository) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseProfileCompletedPayload(envelope);

    await this.travellers.upsert(
      payload.accountId,
      payload.fullName,
      new Date(payload.completedAt),
    );

    this.logger.log(
      `Profile completed for account ${payload.accountId} (${payload.fullName}) (event ${envelope.id})`,
    );

    return { status: 'handled' };
  }
}

