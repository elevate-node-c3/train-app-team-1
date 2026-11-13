import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import * as amqp from 'amqplib';
import { messageOf } from './error-message.js';

export type AmqpReconnectListener = () => void | Promise<void>;

/** A live broker connection does not prove consumers are ready. */
export type AmqpLiveness = { healthy: boolean; detail?: string };

export type AmqpHealth = { status: 'ready' | 'not_ready'; message?: string };

type Closeable = amqp.ChannelModel | amqp.Channel | amqp.ConfirmChannel;

/**
 * Separate publish and consume channels so publish errors cannot cancel consumers.
 * Close in onApplicationShutdown, after consumers finish acknowledging.
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

  // Announce reconnects only after the first connection or a failed startup.
  private announceOpens = false;

  /** Retry with capped delays until the broker returns. */
  private static readonly RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000];

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      return;
    }
    await this.connect(url).catch((error: unknown) => {
      this.logger.warn(`AMQP connection failed at startup: ${messageOf(error)}`);
      // Announce recovery because the startup subscription also failed.
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
    // Close old connection state before dialing again to avoid leaks.
    await this.teardown();

    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();
    this.connection = connection;
    this.channel = channel;

    // Old connections must not clear their replacement's state.
    const forgetConnection = (): void => {
      if (this.connection !== connection) {
        return;
      }
      this.connection = null;
      this.channel = null;
      this.confirmChannel = null;
      // Consumer-only services need automatic reconnects.
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

  /** Close both channels before the connection; try each even after errors. */
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
      // Remove listeners before closing to avoid reconnecting during teardown.
      resource.removeAllListeners();
      await resource.close();
    } catch {
      // Ignore an already closed connection.
    }
  }

  /** Connection and channel errors share one reconnect timer. */
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

  /** Unsubscribe before shutdown to avoid reconnecting during drain. */
  onReconnect(listener: AmqpReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** Register a component's readiness check with {@link checkHealth}. */
  registerLivenessProbe(probe: () => AmqpLiveness): () => void {
    this.livenessProbes.add(probe);
    return () => this.livenessProbes.delete(probe);
  }

  private notifyReconnect(): void {
    // Defer callbacks; reattachment may ask for a channel during connection setup.
    for (const listener of this.reconnectListeners) {
      void Promise.resolve()
        .then(listener)
        .catch((error: unknown) => {
          this.logger.error(`A reconnect listener failed: ${messageOf(error)}`);
        });
    }
  }

  /** Create on demand; throw if configuration is missing. */
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

      // Check a channel round-trip with a server-named queue.
      const { queue } = await this.channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      });
      await this.channel.deleteQueue(queue).catch(() => {});

      // Reconnects may replace the consumer's channel.
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
    // Remove listeners before closing so teardown is not treated as an outage.
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
