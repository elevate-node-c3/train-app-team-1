import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging.module.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';
import { OUTBOX } from './outbox.port.js';
import { EventPublisherService } from '../publisher/event-publisher.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';

/**
 * The producer-side outbox machinery. A service imports this once; the relay
 * is a singleton and starts its loop on `onApplicationBootstrap`.
 */
@Module({
  imports: [MessagingModule],
  providers: [
    TypeOrmOutboxRepository,
    { provide: OUTBOX, useExisting: TypeOrmOutboxRepository },
    EventPublisherService,
    OutboxRelayService,
  ],
  exports: [
    TypeOrmOutboxRepository,
    OUTBOX,
    EventPublisherService,
    OutboxRelayService,
  ],
})
export class OutboxModule {}
