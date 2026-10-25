import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DependencyHealthRegistry,
  type DependencyHealthContributor,
} from '@app/common/health/dependency-health.js';
import { AmqpClientService } from './amqp-client.service.js';

/**
 * Reports the broker into the shared readiness report.
 *
 * This direction is the point: messaging knows about common, not the reverse.
 * `HealthService` used to inject `AmqpClientService` directly, which is what
 * made the two libraries mutually dependent.
 */
@Injectable()
export class AmqpHealthContributor
  implements DependencyHealthContributor, OnModuleInit, OnModuleDestroy
{
  readonly name = 'broker';
  private unregister: (() => void) | null = null;

  constructor(
    private readonly amqp: AmqpClientService,
    private readonly registry: DependencyHealthRegistry,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = null;
  }

  async check(): Promise<{ ready: boolean; message?: string }> {
    const health = await this.amqp.checkHealth();
    return health.status === 'ready'
      ? { ready: true }
      : { ready: false, message: health.message };
  }
}
