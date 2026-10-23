import { Module } from '@nestjs/common';
import { AmqpClientService } from './amqp-client.service.js';

@Module({
  providers: [AmqpClientService],
  exports: [AmqpClientService],
})
export class MessagingModule {}
