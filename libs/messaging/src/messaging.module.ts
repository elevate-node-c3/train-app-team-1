import { Module } from '@nestjs/common';
import { HealthRegistryModule } from '@app/common/health/health-registry.module.js';
import { AmqpClientService } from './amqp-client.service.js';
import { AmqpHealthContributor } from './amqp-health.contributor.js';

@Module({
  imports: [HealthRegistryModule],
  providers: [AmqpClientService, AmqpHealthContributor],
  exports: [AmqpClientService],
})
export class MessagingModule {}
