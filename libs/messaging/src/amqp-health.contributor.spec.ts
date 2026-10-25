import { describe, expect, it, vi } from 'vitest';
import { DependencyHealthRegistry } from '@app/common/health/dependency-health.js';
import { AmqpHealthContributor } from './amqp-health.contributor.js';
import type { AmqpClientService } from './amqp-client.service.js';

function contributorOver(health: { status: string; message?: string }) {
  const registry = new DependencyHealthRegistry();
  const amqp = { checkHealth: vi.fn(async () => health) };
  return {
    registry,
    contributor: new AmqpHealthContributor(
      amqp as unknown as AmqpClientService,
      registry,
    ),
  };
}

describe('AmqpHealthContributor', () => {
  it('registers itself under "broker" on init and leaves on destroy', () => {
    // Push, not pull: a pull would mean @app/common importing @app/messaging,
    // which is the cycle this replaced.
    const { registry, contributor } = contributorOver({ status: 'ready' });
    expect(registry.all()).toEqual([]);

    contributor.onModuleInit();
    expect(registry.all().map((c) => c.name)).toEqual(['broker']);

    contributor.onModuleDestroy();
    expect(registry.all()).toEqual([]);
  });

  it('reports the client answer, message included', async () => {
    const ready = contributorOver({ status: 'ready' });
    await expect(ready.contributor.check()).resolves.toEqual({ ready: true });

    const down = contributorOver({
      status: 'not_ready',
      message: 'Not consuming: notification.q',
    });
    await expect(down.contributor.check()).resolves.toEqual({
      ready: false,
      message: 'Not consuming: notification.q',
    });
  });
});
