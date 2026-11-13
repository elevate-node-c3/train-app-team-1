import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { HealthController as SharedHealthController } from '@app/common';
import { GatewayModule } from '../../gateway.module.js';
import { HealthService } from './health.service.js';

describe('Gateway health aggregation wiring', () => {
  it('gives the shared HealthController the aggregate to answer with', async () => {
    // Missing aggregate binding must not silently fall back to local health.
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    const controller = moduleRef.get(SharedHealthController, { strict: false });

    expect(
      (controller as unknown as { aggregate?: unknown }).aggregate,
    ).toBeInstanceOf(HealthService);
  });
});
