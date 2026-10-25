import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { ErrorCode } from '@app/contracts';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '@app/common';
import {
  RATE_LIMIT_STORE,
  type RateLimitStorePort,
} from '../../../application/ports/rate-limit-store.port.js';

/**
 * One bucket per route and caller. The e-mail address (when the body carries
 * one) makes the sign-in budget per account as well as per address, and the
 * hash keeps PII out of Redis keys and out of any key dump.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE)
    private readonly store: RateLimitStorePort,
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

    const address =
      request.ip ??
      request.socket?.remoteAddress ??
      'unknown';
    const email =
      typeof request.body === 'object' &&
      request.body !== null &&
      typeof (request.body as { email?: unknown }).email === 'string'
        ? (request.body as { email: string }).email.trim().toLowerCase()
        : '';
    const key = `${options.bucket}:${digest(`${address}|${email}`)}`;

    const hit = await this.store.increment(key, options.windowSeconds);
    // A per-process counter is weaker than a shared one, so it is allowed to
    // spend only half the configured budget while Redis is unavailable.
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
