import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELEASE_LOCK_LUA, StampedeGuard } from './stampede-guard.js';

const COMMAND_TIMEOUT_MS = 150;
const lock = {
  lockKey: 'lock:catalog:stations:v1',
  workerId: 'worker-token',
  acquired: true,
};

function fakeRedis() {
  const client = {
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
  };
  return { client, redis: client as unknown as Redis };
}

const operations = [
  {
    name: 'SET',
    command: 'set',
    run: (guard: StampedeGuard, redis: Redis) =>
      guard.acquireLock(redis, lock.lockKey, 60_000),
    fallback: expect.objectContaining({
      lockKey: lock.lockKey,
      workerId: expect.any(String),
      acquired: true,
    }),
    lateValue: null,
  },
  {
    name: 'EVAL',
    command: 'eval',
    run: (guard: StampedeGuard, redis: Redis) =>
      guard.releaseLock(redis, lock),
    fallback: undefined,
    lateValue: 1,
  },
  {
    name: 'EXISTS',
    command: 'exists',
    run: (guard: StampedeGuard, redis: Redis) =>
      guard.isLocked(redis, lock.lockKey),
    fallback: false,
    lateValue: 1,
  },
] as const;

describe('stampede guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('acquires with a unique token, NX and the requested lease TTL', async () => {
    const { client, redis } = fakeRedis();
    const guard = new StampedeGuard();

    const first = await guard.acquireLock(redis, lock.lockKey, 60_000);
    const second = await guard.acquireLock(redis, lock.lockKey);

    expect(first).toEqual({
      lockKey: lock.lockKey,
      workerId: expect.any(String),
      acquired: true,
    });
    expect(second.workerId).not.toBe(first.workerId);
    expect(client.set).toHaveBeenNthCalledWith(
      1,
      lock.lockKey,
      first.workerId,
      'PX',
      60_000,
      'NX',
    );
    expect(client.set).toHaveBeenNthCalledWith(
      2,
      lock.lockKey,
      second.workerId,
      'PX',
      5000,
      'NX',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not release a peer lease after losing NX', async () => {
    const { client, redis } = fakeRedis();
    client.set.mockResolvedValue(null);
    const guard = new StampedeGuard();

    const lostLock = await guard.acquireLock(redis, lock.lockKey);
    expect(lostLock.acquired).toBe(false);
    await expect(guard.releaseLock(redis, lostLock)).resolves.toBeUndefined();

    expect(client.eval).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 0])('releases with token-owned Lua (result %i)', async (result) => {
    const { client, redis } = fakeRedis();
    client.eval.mockResolvedValue(result);

    await expect(
      new StampedeGuard().releaseLock(redis, lock),
    ).resolves.toBeUndefined();

    expect(client.eval).toHaveBeenCalledWith(
      RELEASE_LOCK_LUA,
      1,
      lock.lockKey,
      lock.workerId,
    );
    expect(RELEASE_LOCK_LUA.trim()).toBe(
      'if redis.call("get", KEYS[1]) == ARGV[1] then\n' +
        '  return redis.call("del", KEYS[1])\n' +
        'else\n' +
        '  return 0\n' +
        'end',
    );
    expect(client.del).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 0])('reports whether EXISTS returned %i', async (exists) => {
    const { client, redis } = fakeRedis();
    client.exists.mockResolvedValue(exists);

    await expect(
      new StampedeGuard().isLocked(redis, lock.lockKey),
    ).resolves.toBe(exists === 1);

    expect(client.exists).toHaveBeenCalledWith(lock.lockKey);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(operations)(
    'bounds never-settling $name at 150ms, independently of the lease TTL',
    async ({ command, run, fallback }) => {
      const { client, redis } = fakeRedis();
      client[command].mockReturnValue(new Promise<never>(() => {}));
      const settled = vi.fn();
      const failed = vi.fn();
      const pending = run(new StampedeGuard(), redis).then(settled, failed);

      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toHaveBeenCalledExactlyOnceWith(fallback);
      expect(failed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await pending;
    },
  );

  it.each(operations)(
    'degrades on rejected $name and clears its timer',
    async ({ command, run, fallback }) => {
      const { client, redis } = fakeRedis();
      client[command].mockRejectedValue(new Error('connection reset'));

      await expect(run(new StampedeGuard(), redis)).resolves.toEqual(fallback);
      expect(vi.getTimerCount()).toBe(0);
      expect(client.del).not.toHaveBeenCalled();
    },
  );

  it.each(operations)(
    'handles late $name rejection without an unhandled rejection',
    async ({ command, run, fallback }) => {
      const { client, redis } = fakeRedis();
      let rejectCommand!: (error: Error) => void;
      client[command].mockReturnValue(
        new Promise<never>((_, reject) => {
          rejectCommand = reject;
        }),
      );
      const settled = vi.fn();
      const failed = vi.fn();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const pending = run(new StampedeGuard(), redis).then(settled, failed);
        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
        expect(settled).toHaveBeenCalledExactlyOnceWith(fallback);

        rejectCommand(new Error('late connection reset'));
        await vi.advanceTimersByTimeAsync(1);
        await pending;

        expect(unhandled).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
        expect(settled).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    },
  );

  it.each(operations)(
    'ignores late $name settlement after returning its fallback',
    async ({ command, run, fallback, lateValue }) => {
      const { client, redis } = fakeRedis();
      let resolveCommand!: (value: unknown) => void;
      client[command].mockReturnValue(
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
      );
      const settled = vi.fn();
      const failed = vi.fn();
      const pending = run(new StampedeGuard(), redis).then(settled, failed);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      expect(settled).toHaveBeenCalledExactlyOnceWith(fallback);

      resolveCommand(lateValue);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(settled).toHaveBeenCalledExactlyOnceWith(fallback);
      expect(failed).not.toHaveBeenCalled();
      expect(client.del).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('coalesces local rebuilds and releases singleflight on success', async () => {
    const guard = new StampedeGuard();
    const loader = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await expect(
      Promise.all([
        guard.coalesceInProcess('k', loader),
        guard.coalesceInProcess('k', loader),
      ]),
    ).resolves.toEqual(['first', 'first']);
    await expect(guard.coalesceInProcess('k', loader)).resolves.toBe('second');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('releases singleflight when a rebuild rejects', async () => {
    const guard = new StampedeGuard();
    const loader = vi.fn().mockRejectedValueOnce(new Error('DB failed')).mockResolvedValueOnce('retry');

    await expect(guard.coalesceInProcess('k', loader)).rejects.toThrow('DB failed');
    await expect(guard.coalesceInProcess('k', loader)).resolves.toBe('retry');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
