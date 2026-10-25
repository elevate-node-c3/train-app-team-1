import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AccessLevel, StaffRole } from '@app/contracts';
import { ACCESS_LEVEL_KEY, STAFF_ROLE_KEY } from '@app/common';
import { GatewayModule } from '../../apps/gateway/src/gateway.module.ts';

/**
 * BR-01's public surface, written out literally. The route walk below proves
 * the guard's deny-by-default metadata is present on every registered handler;
 * this set proves the anonymous part is exactly what the story allows. Paths
 * are controller metadata, before the gateway's `/api/v1` prefix.
 */
const BR01_PUBLIC_ROUTES = [
  'GET /',
  'GET /health',
  'GET /health/live',
  'GET /health/ready',
  'GET /ping-all',
  'POST /auth/sign-up',
  'POST /auth/verify-email',
  'POST /auth/resend-verification',
  'POST /auth/sign-in',
  'POST /auth/refresh',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
] as const;

const HTTP_METHODS: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

interface Route {
  method: string;
  path: string;
  level?: AccessLevel;
  roles: StaffRole[];
}

function moduleEntry(value: unknown): {
  type?: Function;
  imports: unknown[];
  controllers: unknown[];
} {
  if (typeof value === 'function') {
    return {
      type: value,
      imports: Reflect.getMetadata('imports', value) ?? [],
      controllers: Reflect.getMetadata('controllers', value) ?? [],
    };
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as {
      module?: unknown;
      imports?: unknown[];
      controllers?: unknown[];
    };
    return {
      type:
        typeof record.module === 'function'
          ? (record.module as Function)
          : undefined,
      imports: record.imports ?? [],
      controllers: record.controllers ?? [],
    };
  }
  return { imports: [], controllers: [] };
}

function registeredControllers(): Set<Function> {
  const controllers = new Set<Function>();
  const visitedModules = new Set<Function>();
  const visitedEntries = new Set<object>();

  const visit = (entry: unknown): void => {
    if (typeof entry === 'object' && entry !== null) {
      if (visitedEntries.has(entry)) return;
      visitedEntries.add(entry);
    }

    const { type, imports, controllers: declared } = moduleEntry(entry);
    if (type && visitedModules.has(type)) return;
    if (type) visitedModules.add(type);

    for (const controller of declared) {
      if (typeof controller === 'function') controllers.add(controller);
    }
    for (const imported of imports) visit(imported);
  };

  visit(GatewayModule);
  return controllers;
}

function routePath(controllerPath: unknown, handlerPath: unknown): string {
  const parts = [controllerPath, handlerPath]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.length > 0,
    )
    .map((value) => value.replace(/^\/+|\/+$/g, ''))
    .filter((value) => value.length > 0);

  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function routes(): Route[] {
  const found: Route[] = [];

  for (const controller of registeredControllers()) {
    const prototype = (controller as { prototype: object }).prototype;
    const classLevel = Reflect.getMetadata(ACCESS_LEVEL_KEY, controller) as
      | AccessLevel
      | undefined;
    const classRoles =
      (Reflect.getMetadata(STAFF_ROLE_KEY, controller) as
        | StaffRole[]
        | undefined) ?? [];

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = Object.getOwnPropertyDescriptor(prototype, name)?.value as
        | Function
        | undefined;
      if (typeof handler !== 'function') continue;

      const method = Reflect.getMetadata('method', handler) as
        | number
        | undefined;
      if (method === undefined) continue;

      const httpMethod = HTTP_METHODS[method];
      if (!httpMethod) {
        throw new Error(
          `Unknown HTTP method ${method} on ${controller.name}.${name}`,
        );
      }

      found.push({
        method: httpMethod,
        path: routePath(
          Reflect.getMetadata('path', controller),
          Reflect.getMetadata('path', handler),
        ),
        level:
          (Reflect.getMetadata(ACCESS_LEVEL_KEY, handler) as
            | AccessLevel
            | undefined) ?? classLevel,
        roles:
          (Reflect.getMetadata(STAFF_ROLE_KEY, handler) as
            | StaffRole[]
            | undefined) ?? classRoles,
      });
    }
  }

  return found;
}

describe('Gateway route access metadata (BR-01, R4)', () => {
  it('declares an access level or a staff role on every HTTP route', () => {
    const missing = routes()
      .filter((route) => !route.level && route.roles.length === 0)
      .map((route) => `${route.method} ${route.path}`);

    expect(missing).toEqual([]);
  });

  it("keeps the anonymous surface exactly BR-01's list", () => {
    const publicRoutes = routes()
      .filter((route) => route.level === 'public')
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(publicRoutes).toEqual([...BR01_PUBLIC_ROUTES].sort());
  });
});
