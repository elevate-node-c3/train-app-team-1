import { Global, Module } from '@nestjs/common';
import { AGGREGATE_READINESS, CommonModule } from '@app/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * `@Global()` so `@app/common`'s HealthController can resolve
 * `AGGREGATE_READINESS` without the library importing this app — which it
 * cannot. Binding it here is what replaced `if (process.env.APP ===
 * 'gateway')` inside that shared controller.
 *
 * One token for both routes: `/health` reaches it through the library's
 * controller, `/api/ping-all` through this module's own.
 */
@Global()
@Module({
  imports: [CommonModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: AGGREGATE_READINESS, useExisting: HealthService },
  ],
  exports: [AGGREGATE_READINESS],
})
export class HealthModule {}
