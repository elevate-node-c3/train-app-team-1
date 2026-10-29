import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import * as amqp from 'amqplib';
import { messageOf } from './error-message.js';

export type AmqpReconnectListener = () => void | Promise<void>;

/** A dependant's own readiness; a live connection does not prove it is usable. */
export type AmqpLiveness = { healthy: boolean; detail?: string };

export type AmqpHealth = { status: 'ready' | 'not_ready'; message?: string };

type Closeable = amqp.ChannelModel | amqp.Channel | amqp.ConfirmChannel;

/**
 * Owns the connection and both channels.
 *
 * Two channels on purpose: a rejected publish cancels every consumer on its
 * channel, so publishers get the confirm channel and consumers the plain one.
 *
 * Closing in `onApplicationShutdown` (Nest's last hook) rather than
 * `onModuleDestroy` (its first) is what lets drains in
 * `beforeApplicationShutdown` land their acks.
 */
@Injectable()
export class AmqpClientService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AmqpClientService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private confirmChannel: amqp.ConfirmChannel | null = null;
  private connecting: Promise<void> | null = null;
  private shuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectListeners = new Set<AmqpReconnectListener>();
  private readonly livenessProbes = new Set<() => AmqpLiveness>();

  /**
   * Whether a successful open must be announced. False until the first connect
   * resolves, because consumers subscribe in `onApplicationBootstrap` and would
   * otherwise subscribe twice. Explicit rather than inferred from Nest's hook
   * order, which this library has already been wrong about once.
   */
  private announceOpens = false;

  /** Capped and repeated, so an hour-long outage still recovers unattended. */
  private static readonly RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      return;
    }
    await this.connect(url).catch((error: unknown) => {
      this.logger.warn(`AMQP connection failed at startup: ${messageOf(error)}`);
      // A consumer's bootstrap subscription fails too, so the eventual dial has
      // to be announced. Compose gates on a healthy broker; this is depth.
      this.announceOpens = true;
      this.scheduleReconnect();
    });
  }

  async connect(url: string): Promise<void> {
    if (this.connection && this.channel) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.open(url).finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private async open(url: string): Promise<void> {
    // A channel can die while its connection lives, which routes here. Dialing
    // on top of the remains leaks it, and its listeners stay armed to null out
    // the state its replacement uses.
    await this.teardown();

    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    this.connection = connection;
    this.channel = channel;

    // Identity-guarded: a close from an already-replaced connection must not
    // clear its successor's channel.
    const forgetConnection = (): void => {
      if (this.connection !== connection) {
        return;
      }
      this.connection = null;
      this.channel = null;
      this.confirmChannel = null;
      // Self-heal: a consuming-only service makes no outbound calls after
      // bootstrap and has no healthcheck polling it, so nothing else would.
      this.scheduleReconnect();
    };
    connection.on('error', forgetConnection);
    connection.on('close', forgetConnection);

    const forgetChannel = (): void => {
      if (this.channel === channel) {
        this.channel = null;
      }
    };
    channel.on('error', forgetChannel);
    channel.on('close', forgetChannel);

    const announce = this.announceOpens;
    this.announceOpens = true;
    if (announce) {
      this.notifyReconnect();
    }
  }

  /** Channels before their connection, each independently best-effort. */
  private async teardown(): Promise<void> {
    const { connection, channel, confirmChannel } = this;
    this.connection = null;
    this.channel = null;
    this.confirmChannel = null;

    await this.release(confirmChannel);
    await this.release(channel);
    await this.release(connection);
  }

  private async release(resource: Closeable | null): Promise<void> {
    if (!resource) {
      return;
    }
    try {
      // Detached first, so the close does not re-enter the handlers above.
      resource.removeAllListeners();
      await resource.close();
    } catch {
      // Already closed, or closing over a socket that is gone.
    }
  }

  /** One timer at a time, so a connection and channel error produce one dial. */
  private scheduleReconnect(attempt = 0): void {
    if (this.shuttingDown || this.reconnectTimer) {
      return;
    }
    if (!process.env.RABBITMQ_URL) {
      return;
    }

    const delays = AmqpClientService.RECONNECT_DELAYS_MS;
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        if (this.shuttingDown) {
          return;
        }
        void this.connect(this.requireUrl()).catch((error: unknown) => {
          this.logger.warn(
            `AMQP reconnect attempt ${attempt + 1} failed: ${messageOf(error)}`,
          );
          this.scheduleReconnect(attempt + 1);
        });
      },
      delays[Math.min(attempt, delays.length - 1)],
    );

    // Never holds the process open at exit.
    this.reconnectTimer.unref?.();
  }

  /**
   * Subscribes to connection replacement. The returned unsubscribe must be
   * called while draining, or a shutdown close reads as an outage.
   */
  onReconnect(listener: AmqpReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** Registers a dependant's readiness answer with {@link checkHealth}. */
  registerLivenessProbe(probe: () => AmqpLiveness): () => void {
    this.livenessProbes.add(probe);
    return () => this.livenessProbes.delete(probe);
  }

  private notifyReconnect(): void {
    // Deferred: a listener re-attaching calls back into `ensureChannel()` while
    // `connect()` still holds `this.connecting`.
    for (const listener of this.reconnectListeners) {
      void Promise.resolve()
        .then(listener)
        .catch((error: unknown) => {
          this.logger.error(`A reconnect listener failed: ${messageOf(error)}`);
        });
    }
  }

  /**
   * The plain channel, connecting lazily. Throws rather than returning null, so
   * a misconfiguration is a readable error instead of a silent no-op.
   */
  async ensureChannel(): Promise<amqp.Channel> {
    if (!this.channel) {
      await this.connect(this.requireUrl());
    }
    if (!this.channel) {
      throw new Error('AMQP channel is not available');
    }
    return this.channel;
  }

  /** The publisher's confirm channel, created on first use. */
  async ensureConfirmChannel(): Promise<amqp.ConfirmChannel> {
    if (!this.connection || !this.channel) {
      await this.connect(this.requireUrl());
    }
    if (!this.connection) {
      throw new Error('AMQP connection is not available');
    }
    if (!this.confirmChannel) {
      const confirm = await this.connection.createConfirmChannel();
      const forget = (): void => {
        if (this.confirmChannel === confirm) {
          this.confirmChannel = null;
        }
      };
      confirm.on('error', forget);
      confirm.on('close', forget);
      this.confirmChannel = confirm;
    }
    return this.confirmChannel;
  }

  private requireUrl(): string {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      throw new Error('RABBITMQ_URL is not configured');
    }
    return url;
  }

  async checkHealth(): Promise<AmqpHealth> {
    try {
      if (!this.connection || !this.channel) {
        if (!process.env.RABBITMQ_URL) {
          return {
            status: 'not_ready',
            message: 'RABBITMQ_URL is not configured',
          };
        }
        await this.connect(this.requireUrl());
      }

      if (!this.channel) {
        return { status: 'not_ready', message: 'Channel not open' };
      }

      // A server-named queue verifies the channel round-trip.
      const { queue } = await this.channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      });
      await this.channel.deleteQueue(queue).catch(() => {});

      // Reconnecting above may have replaced the channel a consumer was
      // subscribed on, and it re-attaches on a later microtask.
      for (const probe of this.livenessProbes) {
        const liveness = probe();
        if (!liveness.healthy) {
          return {
            status: 'not_ready',
            message: liveness.detail ?? 'A broker dependant is not ready',
          };
        }
      }

      return { status: 'ready' };
    } catch (error: unknown) {
      this.channel = null;
      return { status: 'not_ready', message: messageOf(error) };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Dropped before the close, so the teardown is not mistaken for an outage.
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectListeners.clear();
    this.livenessProbes.clear();
    await this.teardown();
  }
}
