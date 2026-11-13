import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as amqp from 'amqplib';
import { AmqpClientService } from '@app/messaging';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

const connect = amqp.connect as unknown as ReturnType<typeof vi.fn>;

const URL = 'amqp://guest:guest@localhost:5672';

/** Real EventEmitters let tests check listener removal from old connections. */
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

    // Replace dead channels without leaking their surviving connection.
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

    // Closing an old connection must not clear its replacement's state.
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

      // Consumer-only services must reconnect without a request or readiness poll.
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

      // Keep retrying longer outages without needing an operator.
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

      // Report startup failures through readiness, not a crashed process.
      await client.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600);

      // Announce startup recovery so failed consumers subscribe again.
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

      // Do not reconnect once the process starts draining.
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

    // Connection reachability alone does not prove a consumer is working.
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
