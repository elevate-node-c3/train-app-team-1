import { Module } from '@nestjs/common';
import { AmqpClientService } from './amqp-client.service.js';
import { AmqpEventPublisher } from './amqp-event-publisher.service.js';

@Module({
  providers: [AmqpClientService, AmqpEventPublisher],
  exports: [AmqpClientService, AmqpEventPublisher],
})
export class MessagingModule {}
