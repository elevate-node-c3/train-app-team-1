import { describe, expect, it } from 'vitest';
import type { MiddlewareConsumer } from '@nestjs/common';
import { ClsMiddleware } from 'nestjs-cls';
import { CommonModule } from './common.module.js';
import { CallerMetadataMiddleware } from './caller/caller-metadata.middleware.js';
import { CorrelationMiddleware } from './correlation/correlation.middleware.js';

/**
 * CLS must run before correlation on every route, including unprefixed health
 * routes. Automatic mounting can miss those routes.
 */
describe('CommonModule middleware chain', () => {
  it('establishes the CLS context before caller stripping and correlation', () => {
    const applied: unknown[] = [];
    let routes: unknown;
    const consumer = {
      apply: (...middleware: unknown[]) => {
        applied.push(...middleware);
        return {
          forRoutes: (value: unknown) => {
            routes = value;
          },
        };
      },
    } as unknown as MiddlewareConsumer;

    new CommonModule().configure(consumer);

    expect(applied).toEqual([
      ClsMiddleware,
      CallerMetadataMiddleware,
      CorrelationMiddleware,
    ]);
    expect(routes).toBe('*');
  });
});
