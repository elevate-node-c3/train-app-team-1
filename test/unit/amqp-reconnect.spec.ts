import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as amqp from 'amqplib';
import { AmqpClientService } from '@app/messaging';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

const connect = amqp.connect as unknown as ReturnType<typeof vi.fn>;

const URL = 'amqp://guest:guest@localhost:5672';

/**
 * Real EventEmitters rather than `{ on: vi.fn() }`: the behaviour under test is
 * precisely that a replaced connection's listeners are detached, and a fake
 * that only records subscriptions cannot tell an attached handler from a
 * removed one.
 */
class FakeChannel extends EventEmitter {
  close = vi.fn(async () => {});
  assertQueue = vi.fn(async () => ({ queue: 'amq.gen-probe' }));
  deleteQueue = vi.fn(async () => {});
}

class FakeConnection extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  close = vi.fn(async () => {});
  createChannel = vi.fn(async () => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  });
  createConfirmChannel = vi.fn(async () => new FakeChannel());
}

/** Lets the deferred reconnect notification run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AmqpClientService connection replacement', () => {
  beforeEach(() => {
    connect.mockReset();
    process.env.RABBITMQ_URL = URL;
  });

  it('closes and detaches the old connection instead of leaking it', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const client = new AmqpClientService();
    await client.connect(URL);

    // A channel can die while its connection survives. That is the path that
    // used to dial a second connection on top of the first.
    first.channels[0].emit('close');
    await client.ensureChannel();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.listenerCount('close')).toBe(0);
    expect(first.listenerCount('error')).toBe(0);
  });

  it('does not let a replaced connection clear the live channel', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const client = new AmqpClientService();
    await client.connect(URL);
    first.channels[0].emit('close');

    const live = await client.ensureChannel();
    expect(live).toBe(second.channels[0]);

    // The orphan finally closes. Before the identity guard and the detach,
    // its handler nulled the connection and channel its successor was using,
    // and every later publish and ack failed against a healthy broker.
    first.emit('close');
    await flush();

    expect(await client.ensureChannel()).toBe(second.channels[0]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('notifies reconnect listeners on replacement but not on first connect', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const client = new AmqpClientService();
    const reattach = vi.fn();
    client.onReconnect(reattach);

    await client.connect(URL);
    await flush();
    // Bootstrap already subscribes; firing here would double-consume.
    expect(reattach).not.toHaveBeenCalled();

    first.emit('close');
    await client.ensureChannel();
    await flush();

    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const client = new AmqpClientService();
    const reattach = vi.fn();
    const unsubscribe = client.onReconnect(reattach);
    await client.connect(URL);

    unsubscribe();
    first.emit('close');
    await client.ensureChannel();
    await flush();

    expect(reattach).not.toHaveBeenCalled();
  });

  it('redials on its own after the broker drops the connection', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    vi.useFakeTimers();
    try {
      const client = new AmqpClientService();
      const reattach = vi.fn();
      client.onReconnect(reattach);
      await client.connect(URL);

      // Nothing is going to ask for a channel: a consuming-only service makes
      // no outbound calls after bootstrap, and its container has no Compose
      // healthcheck to poll readiness either. Waiting to be asked is how
      // notification stayed deaf until someone restarted it.
      first.emit('close');
      expect(connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(reattach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying while the broker stays down', async () => {
    const first = new FakeConnection();
    const recovered = new FakeConnection();
    connect
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(recovered);

    vi.useFakeTimers();
    try {
      const client = new AmqpClientService();
      await client.connect(URL);
      first.emit('close');

      // 500ms, then 1s, then 2s — a broker that is down for a while must still
      // be picked up rather than needing an operator.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(connect).toHaveBeenCalledTimes(4);
      expect(await client.ensureChannel()).toBe(recovered.channels[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers when the broker was down at boot, and announces that open', async () => {
    const recovered = new FakeConnection();
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(recovered);

    vi.useFakeTimers();
    try {
      const client = new AmqpClientService();
      const reattach = vi.fn();
      client.onReconnect(reattach);

      // `onModuleInit` swallows the failure so the service still boots and
      // reports the truth through readiness.
      await client.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);

      // The consumer's own bootstrap subscription already failed, so unlike the
      // ordinary first connect this one has to be announced or the queue is
      // never read.
      expect(connect).toHaveBeenCalledTimes(2);
      expect(reattach).toHaveBeenCalledTimes(1);
      expect(await client.ensureChannel()).toBe(recovered.channels[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending redial at shutdown', async () => {
    const first = new FakeConnection();
    connect.mockResolvedValueOnce(first);

    vi.useFakeTimers();
    try {
      const client = new AmqpClientService();
      await client.connect(URL);
      first.emit('close');

      await client.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(10_000);

      // Still just the original dial: a process on its way out must not
      // reconnect to the broker it is leaving.
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports not_ready while a dependant says it is not consuming', async () => {
    const connection = new FakeConnection();
    connect.mockResolvedValue(connection);

    const client = new AmqpClientService();
    await client.connect(URL);

    let consuming = false;
    client.registerLivenessProbe(() =>
      consuming
        ? { healthy: true }
        : { healthy: false, detail: 'Not consuming: notification.q' },
    );

    // The broker round-trip succeeds either way; this is the gap a pure
    // reachability check cannot see.
    expect(await client.checkHealth()).toEqual({
      status: 'not_ready',
      message: 'Not consuming: notification.q',
    });

    consuming = true;
    expect(await client.checkHealth()).toEqual({ status: 'ready' });
  });

  it('drops listeners at shutdown so the close does not look like an outage', async () => {
    const connection = new FakeConnection();
    connect.mockResolvedValue(connection);

    const client = new AmqpClientService();
    const reattach = vi.fn();
    client.onReconnect(reattach);
    await client.connect(URL);

    await client.onApplicationShutdown();
    await flush();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(reattach).not.toHaveBeenCalled();
  });
});
