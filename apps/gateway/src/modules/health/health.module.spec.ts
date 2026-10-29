import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController as SharedHealthController } from '@app/common';
import { GatewayModule } from '../../gateway.module.js';
import { HealthService } from './health.service.js';

describe('Gateway health aggregation wiring', () => {
  it('gives the shared HealthController the aggregate to answer with', async () => {
    // The failure this guards is silent: without the binding reaching
    // `@app/common`'s controller, `/health` answers the gateway's *local*
    // report with a 200 and a valid envelope, having quietly stopped
    // aggregating the other six.
    //
    // Asserted on the controller's own dependency rather than by resolving the
    // token: a container-wide lookup finds a provider in any module, which
    // says nothing about whether this controller can inject it.
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    const controller = moduleRef.get(SharedHealthController, { strict: false });

    expect(
      (controller as unknown as { aggregate?: unknown }).aggregate,
    ).toBeInstanceOf(HealthService);
  });
});
