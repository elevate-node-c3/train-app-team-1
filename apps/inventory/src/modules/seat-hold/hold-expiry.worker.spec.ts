import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaReadinessGate } from '@app/common';
import { HoldExpiryWorker } from './hold-expiry.worker.js';

function worker(completed = true, schema = new SchemaReadinessGate()) {
  const holds = { expireDueHolds: vi.fn().mockResolvedValue(0) };
  const instance = new HoldExpiryWorker(holds as never, schema, {
    hasCompleted: completed,
  } as never);
  return { instance, holds, schema };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('HoldExpiryWorker durable scans', () => {
  it('runs a bounded database batch without contacting a broker', async () => {
    const { instance, holds } = worker();
    await expect(instance.runOnce()).resolves.toBe(0);
    expect(holds.expireDueHolds).toHaveBeenCalledWith(500);
  });

  it('accepts the configured batch limit', async () => {
    vi.stubEnv('HOLD_EXPIRY_BATCH_SIZE', '100');
    const { instance, holds } = worker();
    await instance.runOnce();
    expect(holds.expireDueHolds).toHaveBeenCalledWith(100);
  });

  it('does not start before successful schema readiness', async () => {
    const schema = new SchemaReadinessGate();
    schema.expectMigrations();
    const { instance, holds } = worker(true, schema);
    instance.onApplicationBootstrap();
    await Promise.resolve();
    expect(holds.expireDueHolds).not.toHaveBeenCalled();

    schema.markSettled();
    await vi.waitFor(() => expect(holds.expireDueHolds).toHaveBeenCalledOnce());
    await instance.beforeApplicationShutdown();
  });

  it('refuses work after a migration failure even when the gate settles', async () => {
    const { instance, holds } = worker(false);
    instance.onApplicationBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(holds.expireDueHolds).not.toHaveBeenCalled();
    await instance.beforeApplicationShutdown();
    expect(holds.expireDueHolds).not.toHaveBeenCalled();
  });

  it('drains nonempty startup backlog without polling delays', async () => {
    const { instance, holds } = worker();
    holds.expireDueHolds.mockResolvedValueOnce(500).mockResolvedValueOnce(7);
    instance.onApplicationBootstrap();
    await vi.waitFor(() =>
      expect(holds.expireDueHolds).toHaveBeenCalledTimes(3),
    );
    await instance.beforeApplicationShutdown();
  });

  it('retries a temporary database failure at the next idle scan', async () => {
    vi.useFakeTimers();
    const { instance, holds } = worker();
    holds.expireDueHolds.mockRejectedValueOnce(
      new Error('temporary database failure'),
    );
    instance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(holds.expireDueHolds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(holds.expireDueHolds).toHaveBeenCalledTimes(2);
    await instance.beforeApplicationShutdown();
  });

  it('can stop while waiting for migrations', async () => {
    const schema = new SchemaReadinessGate();
    schema.expectMigrations();
    const { instance, holds } = worker(true, schema);
    instance.onApplicationBootstrap();
    await instance.beforeApplicationShutdown();
    expect(holds.expireDueHolds).not.toHaveBeenCalled();
  });

  it('stops without waiting out a long idle interval', async () => {
    vi.stubEnv('HOLD_EXPIRY_POLL_INTERVAL_MS', '3600000');
    const { instance, holds } = worker();
    instance.onApplicationBootstrap();
    await vi.waitFor(() => expect(holds.expireDueHolds).toHaveBeenCalledOnce());
    await instance.beforeApplicationShutdown();
    expect(holds.expireDueHolds).toHaveBeenCalledOnce();
  });

  it('does not overlap scans or shutdown with a running transaction', async () => {
    let finish: (count: number) => void = () => {};
    const pending = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const { instance, holds } = worker();
    holds.expireDueHolds.mockReturnValueOnce(pending);
    instance.onApplicationBootstrap();
    await vi.waitFor(() => expect(holds.expireDueHolds).toHaveBeenCalledOnce());

    let stopped = false;
    const shutdown = instance.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(1);
    await shutdown;
    expect(holds.expireDueHolds).toHaveBeenCalledOnce();
  });

  it('can be disabled without disabling key-based release or the outbox', async () => {
    vi.stubEnv('HOLD_EXPIRY_WORKER_ENABLED', 'false');
    const { instance, holds } = worker();
    instance.onApplicationBootstrap();
    await instance.beforeApplicationShutdown();
    expect(holds.expireDueHolds).not.toHaveBeenCalled();
  });
});
