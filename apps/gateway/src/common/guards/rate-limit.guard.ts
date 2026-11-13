import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { ErrorCode } from '@app/contracts';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '@app/common';
import { RateLimitStore } from '../security/stores/rate-limit.store.js';

/** Hash route, IP, and email so Redis keys contain no personal data. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const email =
      typeof request.body === 'object' &&
      request.body !== null &&
      typeof (request.body as { email?: unknown }).email === 'string'
        ? (request.body as { email: string }).email.trim().toLowerCase()
        : '';
    const key = `${options.bucket}:${digest(`${address}|${email}`)}`;

    const hit = await this.store.increment(key, options.windowSeconds);
    // Halve the budget because local counters cannot coordinate across instances.
    const limit = hit.degraded
      ? Math.max(1, Math.ceil(options.limit / 2))
      : options.limit;

    if (hit.count > limit) {
      response.setHeader('Retry-After', String(options.windowSeconds));
      throw new HttpException(
        {
          code: ErrorCode.RATE_LIMITED,
          retryAfterSeconds: options.windowSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}
