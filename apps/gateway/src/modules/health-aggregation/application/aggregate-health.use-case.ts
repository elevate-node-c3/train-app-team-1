import { Inject, Injectable } from '@nestjs/common';
import type { AggregatedHealthReport } from '@app/contracts';
import {
  SERVICE_HEALTH,
  type ServiceHealthPort,
} from './ports/service-health.port.js';

@Injectable()
export class AggregateHealthUseCase {
  constructor(
    @Inject(SERVICE_HEALTH) private readonly serviceHealth: ServiceHealthPort,
  ) {}

  async execute(): Promise<AggregatedHealthReport> {
    return this.serviceHealth.aggregate();
  }
}
