import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '@app/common';
import { RateLimitGuard } from './rate-limit.guard.js';
import type { RateLimitStorePort } from '../../../application/ports/rate-limit-store.port.js';

const OPTIONS: RateLimitOptions = {
  bucket: 'sign-in',
  limit: 10,
  windowSeconds: 60,
};

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

interface Harness {
  guard: RateLimitGuard;
  increment: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function harness(options: RateLimitOptions | null = OPTIONS): Harness {
  const increment = vi.fn(async () => ({ count: 1, degraded: false }));
  const setHeader = vi.fn();
  const reflector = {
    getAllAndOverride: vi.fn((key: string) =>
      key === RATE_LIMIT_KEY ? options : undefined,
    ),
  } as unknown as Reflector;
  const store: RateLimitStorePort = {
    increment: increment as RateLimitStorePort['increment'],
  };

  return {
    guard: new RateLimitGuard(reflector, store),
    increment,
    setHeader,
  };
}

function contextFor(
  request: {
    ip?: string;
    socket?: { remoteAddress?: string };
    body?: unknown;
  },
  setHeader: ReturnType<typeof vi.fn>,
): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

async function rejectionOf(
  promise: Promise<unknown>,
): Promise<HttpException> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('expected the guard to reject');
}

describe('RateLimitGuard (F6d)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not limit a route without @RateLimit', async () => {
    const h = harness(null);

    await expect(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    ).resolves.toBe(true);
    expect(h.increment).not.toHaveBeenCalled();
  });

  it('hashes the address and e-mail out of the bucket key', async () => {
    const h = harness();
    const request = {
      ip: '203.0.113.5',
      body: { email: ' User@Example.COM ' },
    };

    await h.guard.canActivate(contextFor(request, h.setHeader));

    const key = h.increment.mock.calls[0][0] as string;
    expect(key).toBe(`sign-in:${digest('203.0.113.5|user@example.com')}`);
    expect(key).not.toContain('203.0.113.5');
    expect(key).not.toContain('user@example.com');
    expect(h.increment.mock.calls[0][1]).toBe(60);
  });

  it('gives each address and account its own window', async () => {
    const h = harness();

    await h.guard.canActivate(
      contextFor({ ip: '203.0.113.5', body: { email: 'a@example.com' } }, h.setHeader),
    );
    await h.guard.canActivate(
      contextFor({ ip: '203.0.113.5', body: { email: 'b@example.com' } }, h.setHeader),
    );

    expect(h.increment.mock.calls[0][0]).not.toBe(h.increment.mock.calls[1][0]);
  });

  it('falls back to the socket address, then to a stable unknown key', async () => {
    const h = harness();

    await h.guard.canActivate(
      contextFor({ socket: { remoteAddress: '198.51.100.9' } }, h.setHeader),
    );
    await h.guard.canActivate(contextFor({}, h.setHeader));

    expect(h.increment.mock.calls[0][0]).toBe(
      `sign-in:${digest('198.51.100.9|')}`,
    );
    expect(h.increment.mock.calls[1][0]).toBe(`sign-in:${digest('unknown|')}`);
  });

  it('allows the configured budget and rejects the next request', async () => {
    const h = harness();
    h.increment.mockResolvedValueOnce({ count: 10, degraded: false });
    await expect(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    ).resolves.toBe(true);

    h.increment.mockResolvedValueOnce({ count: 11, degraded: false });
    const error = await rejectionOf(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    );

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({
      code: ErrorCode.RATE_LIMITED,
      retryAfterSeconds: 60,
    });
    expect(h.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('halves the budget while Redis is down but still enforces it', async () => {
    const h = harness();
    h.increment.mockResolvedValue({ count: 5, degraded: true });
    await expect(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    ).resolves.toBe(true);

    h.increment.mockResolvedValue({ count: 6, degraded: true });
    const error = await rejectionOf(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    );

    expect(error.getStatus()).toBe(429);
  });

  it('keeps at least one request in the budget for a tiny limit', async () => {
    const h = harness({ ...OPTIONS, limit: 1 });
    h.increment.mockResolvedValue({ count: 1, degraded: true });

    await expect(
      h.guard.canActivate(contextFor({ ip: '1.2.3.4' }, h.setHeader)),
    ).resolves.toBe(true);
  });

  it('does not trust a body that is not an object', async () => {
    const h = harness();

    await h.guard.canActivate(
      contextFor({ ip: '1.2.3.4', body: 'email=a@example.com' }, h.setHeader),
    );

    expect(h.increment.mock.calls[0][0]).toBe(`sign-in:${digest('1.2.3.4|')}`);
  });
});
