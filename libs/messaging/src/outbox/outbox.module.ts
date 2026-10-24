import { Module } from '@nestjs/common';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import { MessagingModule } from '../messaging.module.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';
import { OUTBOX } from './outbox.port.js';
import { EventPublisherService } from '../publisher/event-publisher.service.js';
import { OutboxRelayService } from './outbox-relay.service.js';

/**
 * The producer-side outbox machinery. A service imports this once; the relay
 * is a singleton and starts its loop on `onApplicationBootstrap`.
 *
 * `UNIT_OF_WORK` is bound here rather than in the importing feature module
 * because Nest's DI is module-scoped: the relay lives in this module, so a
 * provider declared by the module that *imports* this one would be invisible to
 * it. Exporting the token also lets the feature's use-case inject the very same
 * unit of work, which is what makes "same context, same transaction" true.
 */
@Module({
  imports: [MessagingModule],
  providers: [
    TypeOrmUnitOfWork,
    { provide: UNIT_OF_WORK, useExisting: TypeOrmUnitOfWork },
    TypeOrmOutboxRepository,
    { provide: OUTBOX, useExisting: TypeOrmOutboxRepository },
    EventPublisherService,
    OutboxRelayService,
  ],
  exports: [
    UNIT_OF_WORK,
    TypeOrmOutboxRepository,
    OUTBOX,
    EventPublisherService,
    OutboxRelayService,
  ],
})
export class OutboxModule {}
