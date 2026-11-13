import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CacheAsideService,
  REDIS_OP_TIMEOUT_MS,
} from './cache-aside.service.js';
import type { RedisClientService } from './redis-client.service.js';

interface FakeClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
}

function withRedis(client: FakeClient | null): {
  cache: CacheAsideService;
  client: FakeClient | null;
} {
  const redis = {
    isAvailable: () => client !== null,
    getClient: () => client,
  } as unknown as RedisClientService;

  return { cache: new CacheAsideService(redis), client };
}

function fakeClient(stored: string | null = null): FakeClient {
  return {
    get: vi.fn().mockResolvedValue(stored),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
  };
}

const lockCommands = ['SET', 'EVAL', 'EXISTS'] as const;

function lockFailureClient(
  command: (typeof lockCommands)[number],
  operation: () => Promise<unknown>,
): FakeClient {
  const client = fakeClient();
  client.set.mockImplementation(
    (_key: string, _value: string, mode: string) => {
      if (mode !== 'PX') return Promise.resolve('OK');
      if (command === 'SET') return operation();
      return Promise.resolve(command === 'EXISTS' ? null : 'OK');
    },
  );
  if (command === 'EVAL') client.eval.mockImplementation(operation);
  if (command === 'EXISTS') client.exists.mockImplementation(operation);
  return client;
}

describe('cache-aside', () => {
  it('returns null on a miss', async () => {
    const { cache } = withRedis(fakeClient(null));

    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('returns the decoded value on a hit', async () => {
    const { cache } = withRedis(fakeClient('{"a":1}'));

    await expect(cache.get<{ a: number }>('k')).resolves.toEqual({ a: 1 });
  });

  it('stores JSON with the ttl it was given', async () => {
    const { cache, client } = withRedis(fakeClient());

    await cache.set('k', { a: 1 }, 300);

    expect(client!.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 300);
  });

  it('deletes a key', async () => {
    const { cache, client } = withRedis(fakeClient());

    await cache.del('k');

    expect(client!.del).toHaveBeenCalledWith('k');
  });

  it.each(['initial', 'warm'])(
    'rebuilds a type-invalid %s cache value',
    async (position) => {
      const client = fakeClient('{"a":"wrong type"}');
      if (position === 'warm') client.get.mockResolvedValueOnce(null);
      const { cache } = withRedis(client);
      const loader = vi.fn(async () => ({ a: 1 }));
      const isValid = (value: unknown): value is { a: number } =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { a?: unknown }).a === 'number';

      await expect(
        cache.getOrRebuild('k', 'stations', loader, 300, { isValid }),
      ).resolves.toEqual({ a: 1 });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 300);
    },
  );

  // Degrade, never fail: a cache outage must not turn search into an error.
  // The same contract RateLimitStore keeps.
  describe('when Redis is unavailable', () => {
    it('reports a miss instead of throwing', async () => {
      const { cache } = withRedis(null);

      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('accepts a write and drops it', async () => {
      const { cache } = withRedis(null);

      await expect(cache.set('k', { a: 1 }, 300)).resolves.toBeUndefined();
    });

    it('accepts a delete and drops it', async () => {
      const { cache } = withRedis(null);

      await expect(cache.del('k')).resolves.toBeUndefined();
    });
  });

  describe('when Redis misbehaves', () => {
    it('treats a read error as a miss', async () => {
      const client = fakeClient();
      client.get.mockRejectedValue(new Error('connection reset'));
      const { cache } = withRedis(client);

      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('swallows a write error', async () => {
      const client = fakeClient();
      client.set.mockRejectedValue(new Error('OOM'));
      const { cache } = withRedis(client);

      await expect(cache.set('k', { a: 1 }, 300)).resolves.toBeUndefined();
    });

    it('swallows a delete error', async () => {
      const client = fakeClient();
      client.del.mockRejectedValue(new Error('connection reset'));
      const { cache } = withRedis(client);

      await expect(cache.del('k')).resolves.toBeUndefined();
    });

    it('treats undecodable JSON as a miss', async () => {
      const { cache } = withRedis(fakeClient('not json at all'));

      await expect(cache.get('k')).resolves.toBeNull();
    });
  });

  // A generation counter is the one thing here a caller cannot treat as
  // best-effort, so increment reports its failures instead of swallowing them.
  describe('increment', () => {
    it('returns the new counter value', async () => {
      const client = fakeClient();
      client.incr.mockResolvedValue(7);
      const { cache } = withRedis(client);

      await expect(cache.increment('gen')).resolves.toBe(7);
    });

    it.each([
      ['an outage', null],
      ['a rejected command', fakeClient()],
    ])('returns null on %s', async (_label, client) => {
      if (client) client.incr.mockRejectedValue(new Error('down'));
      const { cache } = withRedis(client);

      await expect(cache.increment('gen')).resolves.toBeNull();
    });
  });

  describe('read-through with a connected Redis lock failure', () => {
    const key = 'catalog:stations:v1';
    const pollIntervalMs = 25;
    const options = { maxWaitMs: 60_000, pollIntervalMs };
    const firstValue = { revision: 1 };
    const secondValue = { revision: 2 };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each(lockCommands)(
      'responds and clears singleflight after never-settling %s',
      async (command) => {
        const client = lockFailureClient(
          command,
          () => new Promise<never>(() => {}),
        );
        const { cache } = withRedis(client);
        const loader = vi
          .fn()
          .mockResolvedValueOnce(firstValue)
          .mockResolvedValueOnce(secondValue);
        const settled = vi.fn();
        const joined = vi.fn();
        const failed = vi.fn();
        const first = cache
          .getOrRebuild(key, 'stations', loader, 300, options)
          .then(settled, failed);
        const concurrent = cache
          .getOrRebuild(key, 'stations', loader, 300, options)
          .then(joined, failed);
        const budgetMs =
          REDIS_OP_TIMEOUT_MS + (command === 'EXISTS' ? pollIntervalMs : 0);

        await vi.advanceTimersByTimeAsync(budgetMs - 1);
        expect(settled).not.toHaveBeenCalled();
        expect(joined).not.toHaveBeenCalled();
        expect(loader).toHaveBeenCalledTimes(command === 'EVAL' ? 1 : 0);
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toHaveBeenCalledExactlyOnceWith(firstValue);
        expect(joined).toHaveBeenCalledExactlyOnceWith(firstValue);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(failed).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await Promise.all([first, concurrent]);

        // GET stays a miss so this observes singleflight cleanup, not a cache hit.
        const retried = vi.fn();
        const second = cache
          .getOrRebuild(key, 'stations', loader, 300, options)
          .then(retried, failed);
        await vi.advanceTimersByTimeAsync(budgetMs);

        expect(retried).toHaveBeenCalledExactlyOnceWith(secondValue);
        expect(loader).toHaveBeenCalledTimes(2);
        expect(failed).not.toHaveBeenCalled();
        expect(client.del).not.toHaveBeenCalled();
        if (command === 'EXISTS') expect(client.eval).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await second;
      },
    );

    it.each(lockCommands)(
      'rebuilds and allows a second request after rejected %s',
      async (command) => {
        const client = lockFailureClient(command, () =>
          Promise.reject(new Error('connection reset')),
        );
        const { cache } = withRedis(client);
        const loader = vi
          .fn()
          .mockResolvedValueOnce(firstValue)
          .mockResolvedValueOnce(secondValue);
        const failed = vi.fn();
        const waitMs = command === 'EXISTS' ? pollIntervalMs : 0;

        for (const value of [firstValue, secondValue]) {
          const settled = vi.fn();
          const pending = cache
            .getOrRebuild(key, 'stations', loader, 300, options)
            .then(settled, failed);
          await vi.advanceTimersByTimeAsync(waitMs);

          expect(settled).toHaveBeenCalledExactlyOnceWith(value);
          expect(failed).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
          await pending;
        }
        expect(loader).toHaveBeenCalledTimes(2);
        expect(client.del).not.toHaveBeenCalled();
        if (command === 'EXISTS') expect(client.eval).not.toHaveBeenCalled();
      },
    );

    it('releases singleflight after a failed loader and a stalled release', async () => {
      const client = lockFailureClient(
        'EVAL',
        () => new Promise<never>(() => {}),
      );
      const { cache } = withRedis(client);
      const error = new Error('DB failed');
      const loader = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(secondValue);
      const settled = vi.fn();
      const failed = vi.fn();
      const first = cache
        .getOrRebuild(key, 'stations', loader, 300)
        .then(settled, failed);
      await vi.advanceTimersByTimeAsync(REDIS_OP_TIMEOUT_MS);

      expect(failed).toHaveBeenCalledExactlyOnceWith(error);
      expect(settled).not.toHaveBeenCalled();
      await first;

      const second = cache
        .getOrRebuild(key, 'stations', loader, 300)
        .then(settled, failed);
      await vi.advanceTimersByTimeAsync(REDIS_OP_TIMEOUT_MS);

      expect(settled).toHaveBeenCalledExactlyOnceWith(secondValue);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      await second;
    });

    it('reaches the loader and responds when all Redis replies stall', async () => {
      const client = fakeClient();
      const never = () => new Promise<never>(() => {});
      client.get.mockImplementation(never);
      client.set.mockImplementation(never);
      client.eval.mockImplementation(never);
      client.exists.mockImplementation(never);
      const { cache } = withRedis(client);
      const loader = vi
        .fn()
        .mockResolvedValueOnce(firstValue)
        .mockResolvedValueOnce(secondValue);
      const failed = vi.fn();

      for (const value of [firstValue, secondValue]) {
        const settled = vi.fn();
        const pending = cache
          .getOrRebuild(key, 'stations', loader, 300)
          .then(settled, failed);
        // Two GET deadlines and the lock SET deadline precede the DB query.
        await vi.advanceTimersByTimeAsync(3 * REDIS_OP_TIMEOUT_MS);
        expect(loader).toHaveBeenCalledTimes(value.revision);
        expect(settled).not.toHaveBeenCalled();
        // The cache write and token-owned release each have their own deadline.
        await vi.advanceTimersByTimeAsync(2 * REDIS_OP_TIMEOUT_MS);

        expect(settled).toHaveBeenCalledExactlyOnceWith(value);
        expect(failed).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await pending;
      }
    });
  });
});
