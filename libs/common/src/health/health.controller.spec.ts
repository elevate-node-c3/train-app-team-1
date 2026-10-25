import { describe, expect, it, vi } from 'vitest';
import type { AggregatedHealthReport, ServiceHealthReport } from '@app/contracts';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';
import type { AggregateReadiness } from './aggregate-readiness.js';

const LOCAL = {
  service: 'booking',
  status: 'ready',
  dependencies: {},
  timestamp: '2026-10-25T00:00:00.000Z',
} as ServiceHealthReport;

const AGGREGATE = {
  status: 'ready',
  gateway: LOCAL,
  services: {},
  timestamp: '2026-10-25T00:00:00.000Z',
} as AggregatedHealthReport;

function controllerWith(aggregate?: AggregateReadiness) {
  const checkReadiness = vi.fn(async () => LOCAL);
  const health = {
    checkReadiness,
    checkLiveness: () => ({ status: 'live' as const, timestamp: 'now' }),
  } as unknown as HealthService;
  return {
    controller: new HealthController(health, aggregate),
    checkReadiness,
  };
}

describe('HealthController', () => {
  it('reports only itself when nothing is bound', async () => {
    // Six of seven services. No env var is consulted to discover that.
    const { controller, checkReadiness } = controllerWith();

    await expect(controller.ready()).resolves.toBe(LOCAL);
    await expect(controller.health()).resolves.toBe(LOCAL);
    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('answers with the aggregate once one is bound', async () => {
    // The gateway. `/health` and `/health/ready` both return the aggregate,
    // which is the shape walkthrough.md and postman/ document.
    const aggregate = { aggregate: vi.fn(async () => AGGREGATE) };
    const { controller, checkReadiness } = controllerWith(aggregate);

    await expect(controller.ready()).resolves.toBe(AGGREGATE);
    await expect(controller.health()).resolves.toBe(AGGREGATE);
    expect(aggregate.aggregate).toHaveBeenCalledTimes(2);
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it('keeps liveness local and independent of aggregation', async () => {
    const aggregate = { aggregate: vi.fn(async () => AGGREGATE) };
    const { controller } = controllerWith(aggregate);

    expect(controller.live().status).toBe('live');
    expect(aggregate.aggregate).not.toHaveBeenCalled();
  });
});
