import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ACCOUNT_REGISTERED_EVENT_TYPE,
  ACCOUNT_REGISTERED_VERSION,
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_VERSION,
} from '@app/contracts';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from '@app/messaging/consumer/event-subscription.js';
import { EventConsumerService } from '@app/messaging/consumer/event-consumer.service.js';
import { EventFailureRouter } from '@app/messaging/consumer/event-failure-router.js';
import { MessageRepublisher } from '@app/messaging/consumer/message-republisher.js';
import { PROCESSED_EVENT_STORE } from '@app/messaging/consumer/processed-event.port.js';
import { TypeOrmProcessedEventStore } from '@app/messaging/consumer/typeorm-processed-event.store.js';
import { MessagingModule } from '@app/messaging';
import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';
import { AccountRegisteredConsumer } from './consumers/account-registered.consumer.js';
import { VerificationCodeIssuedConsumer } from './consumers/verification-code-issued.consumer.js';
import { EmailDeliveryRepository } from './email-delivery.repository.js';
import { NodemailerEmailSender } from './email-sender.js';
import { EmailDeliveryEntity } from './entities/email-delivery.entity.js';

/** The consumer's own queue. A second consumer gets a different one. */
export const VERIFICATION_EMAIL_QUEUE = 'notification.verification-code-issued';
export const ACCOUNT_REGISTERED_QUEUE = 'notification.account-registered';

/**
 * Pure on purpose: the module's DI factory receives the handler and returns
 * data. No transport is built, no environment is read, and no SMTP socket is
 * opened here — `test/skeleton/apps.spec.ts` compiles the root module with no
 * Docker, and a factory with a side effect would fail that test.
 */
export function createVerificationEmailSubscriptions(
  handler: EventHandlerPort,
  accountRegistered: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: VERIFICATION_CODE_ISSUED_EVENT_TYPE,
      version: VERIFICATION_CODE_ISSUED_VERSION,
      queueName: VERIFICATION_EMAIL_QUEUE,
      handler,
    },
    {
      eventType: ACCOUNT_REGISTERED_EVENT_TYPE,
      version: ACCOUNT_REGISTERED_VERSION,
      queueName: ACCOUNT_REGISTERED_QUEUE,
      handler: accountRegistered,
    },
  ];
}

/**
 * The feature owns its consumer runtime because it owns the subscriptions.
 * `MessagingModule` supplies the shared connection; binding the store and the
 * concrete sender/repository here keeps the consumers unaware of TypeORM and
 * nodemailer.
 */
@Module({
  imports: [MessagingModule, TypeOrmModule.forFeature([EmailDeliveryEntity])],
  providers: [
    VerificationCodeIssuedConsumer,
    AccountRegisteredConsumer,
    NodemailerEmailSender,
    EmailDeliveryRepository,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createVerificationEmailSubscriptions,
      inject: [VerificationCodeIssuedConsumer, AccountRegisteredConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [VerificationCodeIssuedConsumer],
})
export class VerificationEmailsModule {}
