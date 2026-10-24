import { Injectable } from '@nestjs/common';
import { GatewayHealthService } from '@app/common';
import type { AggregatedHealthReport } from '@app/contracts';
import type { ServiceHealthPort } from '../../application/ports/service-health.port.js';

/**
 * Adapts `@app/common`'s gRPC fan-out to the application's port. The
 * client-building, per-service timeout and degraded-mode handling all live in
 * the library because all seven services share them; this class exists so the
 * use-case does not have to know that.
 */
@Injectable()
export class GatewayHealthAdapter implements ServiceHealthPort {
  constructor(private readonly gatewayHealth: GatewayHealthService) {}

  async aggregate(): Promise<AggregatedHealthReport> {
    return this.gatewayHealth.aggregate();
  }
}
