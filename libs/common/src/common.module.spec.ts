import { describe, expect, it } from 'vitest';
import type { MiddlewareConsumer } from '@nestjs/common';
import { ClsMiddleware } from 'nestjs-cls';
import { CommonModule } from './common.module.js';
import { CallerMetadataMiddleware } from './caller/caller-metadata.middleware.js';
import { CorrelationMiddleware } from './correlation/correlation.middleware.js';

/**
 * The gateway's global prefix exposed an ordering bug: the automatically
 * mounted ClsMiddleware did not run for excluded routes such as /health/live,
 * so CorrelationMiddleware wrote into a store that did not exist and the route
 * answered 500. Pinning the chain here makes the order explicit in every
 * service, not dependent on module scanning.
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
