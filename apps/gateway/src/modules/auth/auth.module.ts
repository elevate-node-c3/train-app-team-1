import { Module } from '@nestjs/common';
import {
  SESSION_REVOKED_EVENT_TYPE,
  SESSION_REVOKED_VERSION,
} from '@app/contracts';
import {
  MessagingModule,
} from '@app/messaging';
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
import { AccountsModule } from '../accounts/accounts.module.js';
import { ACCESS_TOKEN_VERIFIER } from './application/ports/access-token-verifier.port.js';
import { GatewayJwtVerifier } from './infrastructure/security/gateway-jwt.verifier.js';
import { REVOCATION_STORE } from './application/ports/revocation-store.port.js';
import { RATE_LIMIT_STORE } from './application/ports/rate-limit-store.port.js';
import { RevocationStore } from './infrastructure/security/revocation.store.js';
import { RateLimitStore } from './infrastructure/security/rate-limit.store.js';
import { HandleSessionRevokedUseCase } from './application/use-cases/handle-session-revoked.use-case.js';
import { AuthHttpController } from './presentation/http/auth.http.controller.js';
import { StaffHttpController } from './presentation/http/staff.http.controller.js';
import { JwtAuthGuard } from './presentation/http/guards/jwt-auth.guard.js';
import { RateLimitGuard } from './presentation/http/guards/rate-limit.guard.js';

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

@Module({
  imports: [AccountsModule, MessagingModule],
  controllers: [AuthHttpController, StaffHttpController],
  providers: [
    { provide: ACCESS_TOKEN_VERIFIER, useClass: GatewayJwtVerifier },
    { provide: REVOCATION_STORE, useClass: RevocationStore },
    { provide: RATE_LIMIT_STORE, useClass: RateLimitStore },
    JwtAuthGuard,
    RateLimitGuard,
    HandleSessionRevokedUseCase,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createSessionRevokedSubscriptions,
      inject: [HandleSessionRevokedUseCase],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [
    JwtAuthGuard,
    RateLimitGuard,
    ACCESS_TOKEN_VERIFIER,
    REVOCATION_STORE,
    RATE_LIMIT_STORE,
  ],
})
export class AuthModule {}
