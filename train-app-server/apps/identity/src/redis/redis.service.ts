import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(configService: ConfigService) {
    this.client = new Redis({
      host: configService.get<string>('REDIS_HOST', '127.0.0.1'),
      port: Number(configService.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) => Math.min(times * 500, 3000),
    });
  }

  async canResend(email: string): Promise<number> {
    const key = `verification:${email.trim().toLowerCase()}`;
    const cooldown = await this.client.ttl(`${key}:cooldown`);

    if (cooldown > 0) {
      return cooldown;
    }

    const count = await this.client.get(`${key}:count`);

    if (Number(count ?? 0) >= 5) {
      const countTtl = await this.client.ttl(`${key}:count`);

      if (countTtl > 0) {
        return countTtl;
      }

      return 3600;
    }

    return 0;
  }

  async recordResend(email: string): Promise<void> {
    const key = `verification:${email.trim().toLowerCase()}`;

    const count = await this.client.incr(`${key}:count`);

    if (count === 1) {
      await this.client.expire(`${key}:count`, 3600);
    }

    await this.client.set(`${key}:cooldown`, '1', 'EX', 120);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') {
      await this.client.quit();
    }
  }
}
