import { Module } from '@nestjs/common';
import {
  SESSION_REVOKED_EVENT_TYPE,
  SESSION_REVOKED_VERSION,
} from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from '@app/messaging/consumer/event-subscription.js';
import { EventConsumerService } from '@app/messaging/consumer/event-consumer.service.js';
import { EventFailureRouter } from '@app/messaging/consumer/event-failure-router.js';
import { MessageRepublisher } from '@app/messaging/consumer/message-republisher.js';
import { PROCESSED_EVENT_STORE } from '@app/messaging/consumer/processed-event.port.js';
import { TypeOrmProcessedEventStore } from '@app/messaging/consumer/typeorm-processed-event.store.js';
import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';
import { SessionRevokedConsumer } from './session-revoked.consumer.js';
import { RateLimitStore } from './stores/rate-limit.store.js';
import { RevocationStore } from './stores/revocation.store.js';
import { TokenVerifierService } from './token-verifier.service.js';

/** A queue per consumer: sign-out must not share notification's mailbox. */
export const SESSION_REVOKED_QUEUE = 'gateway.identity-session-revoked';

export function createSessionRevokedSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: SESSION_REVOKED_EVENT_TYPE,
      version: SESSION_REVOKED_VERSION,
      queueName: SESSION_REVOKED_QUEUE,
      handler,
    },
  ];
}

/**
 * The gateway's shared security runtime: token verification, revocation
 * markers, rate-limit counters and the session-revoked consumer.
 *
 * `GatewayModule` imports this module so both `APP_GUARD`s can resolve their
 * concrete dependencies. The consumer runtime lives here because this module
 * owns the only gateway subscription.
 */
@Module({
  imports: [MessagingModule],
  providers: [
    TokenVerifierService,
    RevocationStore,
    RateLimitStore,
    SessionRevokedConsumer,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createSessionRevokedSubscriptions,
      inject: [SessionRevokedConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [TokenVerifierService, RevocationStore, RateLimitStore],
})
export class SecurityModule {}
