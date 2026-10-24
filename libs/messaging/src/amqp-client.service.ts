import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import * as amqp from 'amqplib';

/**
 * Owns the service's AMQP connection and channels.
 *
 * There are deliberately **two** channels. Consumers and topology assertions
 * use the plain channel; publishers use the confirm channel. Sharing one would
 * mean a publisher waiting for `waitForConfirms()` while a consumer's ack is
 * queued behind it — and a rejected publish on a channel cancels every consumer
 * on that channel (the "channel error" rule in AMQP).
 *
 * Shutdown lives in `onApplicationShutdown`, the *last* Nest hook. The relay and
 * consumers drain in `beforeApplicationShutdown`, which Nest calls while this
 * channel is still open, so every in-flight ack can land before the channel
 * closes. Closing in `onModuleDestroy` — which Nest calls first — would turn a
 * clean deploy into a batch of duplicate emails.
 */
@Injectable()
export class AmqpClientService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AmqpClientService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private confirmChannel: amqp.ConfirmChannel | null = null;
  private connecting: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL;
    if (url) {
      await this.connect(url).catch((error: unknown) => {
        // Startup stays resilient; the readiness probe reports the truth.
        this.logger.warn(
          `AMQP connection failed at startup: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  /** Opens the shared connection and the plain channel, once. */
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
    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();

    this.connection = connection;
    this.channel = channel;

    connection.on('error', () => {
      this.connection = null;
      this.channel = null;
      this.confirmChannel = null;
    });
    connection.on('close', () => {
      this.connection = null;
      this.channel = null;
      this.confirmChannel = null;
    });
    channel.on('error', () => {
      this.channel = null;
    });
    channel.on('close', () => {
      this.channel = null;
    });
  }

  /**
   * The plain channel, connecting lazily if needed. Used by consumers and by
   * topology declaration. Throws when no broker is configured rather than
   * returning null, so a misconfiguration is a readable error instead of a
   * silent no-op.
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

  /**
   * The publisher's confirm channel. Separate from {@link ensureChannel} for
   * the reason in the class comment; created on first use so a service that
   * only consumes never pays for it.
   */
  async ensureConfirmChannel(): Promise<amqp.ConfirmChannel> {
    if (!this.connection || !this.channel) {
      await this.connect(this.requireUrl());
    }
    if (!this.connection) {
      throw new Error('AMQP connection is not available');
    }
    if (!this.confirmChannel) {
      const confirm = await this.connection.createConfirmChannel();
      confirm.on('error', () => {
        this.confirmChannel = null;
      });
      confirm.on('close', () => {
        this.confirmChannel = null;
      });
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

  async checkHealth(): Promise<{
    status: 'ready' | 'not_ready';
    message?: string;
  }> {
    try {
      if (!this.connection || !this.channel) {
        const url = process.env.RABBITMQ_URL;
        if (!url) {
          return {
            status: 'not_ready',
            message: 'RABBITMQ_URL is not configured',
          };
        }
        await this.connect(url);
      }

      if (this.channel) {
        // Assert a temporary server-named queue to verify channel round-trip.
        const { queue } = await this.channel.assertQueue('', {
          exclusive: true,
          autoDelete: true,
        });
        await this.channel.deleteQueue(queue).catch(() => {});
        return { status: 'ready' };
      }

      return { status: 'not_ready', message: 'Channel not open' };
    } catch (err: unknown) {
      this.channel = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      return { status: 'not_ready', message: errMsg };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      if (this.confirmChannel) {
        await this.confirmChannel.close().catch(() => {});
        this.confirmChannel = null;
      }
      if (this.channel) {
        await this.channel.close().catch(() => {});
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close().catch(() => {});
        this.connection = null;
      }
    } catch {
      // Ignore shutdown errors.
    }
  }
}
