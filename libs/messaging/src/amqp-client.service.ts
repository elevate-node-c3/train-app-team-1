import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';

@Injectable()
export class AmqpClientService implements OnModuleInit, OnModuleDestroy {
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private connecting = false;

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL;
    if (url) {
      await this.connect(url).catch(() => {
        // We catch here so startup is resilient; health checks will report actual status
      });
    }
  }

  async connect(url: string): Promise<void> {
    if (this.connection && this.channel) {
      return;
    }
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();

      this.connection.on('error', () => {
        this.connection = null;
        this.channel = null;
      });

      this.connection.on('close', () => {
        this.connection = null;
        this.channel = null;
      });

      this.channel.on('error', () => {
        this.channel = null;
      });

      this.channel.on('close', () => {
        this.channel = null;
      });
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Opens a confirm channel on the shared connection, connecting first if
   * needed. The caller owns the channel.
   * @returns the new confirm channel
   */
  async createConfirmChannel(): Promise<amqp.ConfirmChannel> {
    if (!this.connection) {
      const url = process.env.RABBITMQ_URL;
      if (!url) {
        throw new Error('RABBITMQ_URL is not configured');
      }
      await this.connect(url);
    }
    if (!this.connection) {
      throw new Error('RabbitMQ connection is not open');
    }
    return this.connection.createConfirmChannel();
  }

  async checkHealth(): Promise<{
    status: 'ready' | 'not_ready';
    message?: string;
  }> {
    try {
      const url = process.env.RABBITMQ_URL;
      if (!this.connection || !this.channel) {
        if (!url) {
          return {
            status: 'not_ready',
            message: 'RABBITMQ_URL is not configured',
          };
        }
        await this.connect(url);
      }

      if (this.channel) {
        // Assert a temporary server-named queue to verify channel round-trip
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

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close().catch(() => {});
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close().catch(() => {});
        this.connection = null;
      }
    } catch {
      // Ignore shutdown errors
    }
  }
}
