import { readFileSync } from 'node:fs';
import type { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as catalogModule from '../../apps/catalog/src/catalog.module.js';
import * as gatewayModule from '../../apps/gateway/src/gateway.module.js';
import * as identityModule from '../../apps/identity/src/identity.module.js';
import * as inventoryModule from '../../apps/inventory/src/inventory.module.js';
import * as bookingModule from '../../apps/booking/src/booking.module.js';
import * as paymentModule from '../../apps/payment/src/payment.module.js';
import * as notificationModule from '../../apps/notification/src/notification.module.js';

const SERVICES = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;

// Vite cannot analyze two interpolations in one import path.
// Use a static map to test each module on its own.
const MODULES: Record<(typeof SERVICES)[number], Record<string, unknown>> = {
  catalog: catalogModule,
  gateway: gatewayModule,
  identity: identityModule,
  inventory: inventoryModule,
  booking: bookingModule,
  payment: paymentModule,
  notification: notificationModule,
};

const nestCli = JSON.parse(readFileSync('nest-cli.json', 'utf8'));

describe('service apps', () => {
  it('registers exactly the seven services as applications', () => {
    const apps = Object.entries(nestCli.projects)
      .filter(([, p]: [string, any]) => p.type === 'application')
      .map(([name]) => name);
    expect(apps.sort()).toEqual([...SERVICES].sort());
  });

  it('points the default project at the gateway', () => {
    expect(nestCli.root).toBe('apps/gateway');
    expect(nestCli.sourceRoot).toBe('apps/gateway/src');
  });

  // Pin the documented GET /<service> routes and the gateway's GET /.
  // `path` and `controllers` are Nest metadata keys.
  it.each(SERVICES)('%s serves its documented identity route', (service) => {
    const pascal = service[0].toUpperCase() + service.slice(1);
    const moduleClass = MODULES[service][`${pascal}Module`] as object;

    const controllers =
      (Reflect.getMetadata('controllers', moduleClass) as
        | (new () => Record<string, () => { service: string }>)[]
        | undefined) ?? [];
    const controller = controllers.find(
      (candidate) => candidate.name === 'ServiceInfoController',
    );
    expect(controller).toBeDefined();

    const path = Reflect.getMetadata('path', controller!);
    expect(path).toBe(service === 'gateway' ? '/' : service);

    const method = service === 'gateway' ? 'getRoot' : 'getInfo';
    expect(new controller!()[method]().service).toBe(service);
  });

  it.each(SERVICES)(
    '%s has a module that compiles on its own',
    async (service) => {
      const pascal = service[0].toUpperCase() + service.slice(1);
      const mod = MODULES[service];
      // Namespace imports do not guarantee a module class export.
      const moduleClass = mod[`${pascal}Module`] as Type<unknown> | undefined;
      expect(moduleClass).toBeDefined();
      await expect(
        Test.createTestingModule({ imports: [moduleClass!] }).compile(),
      ).resolves.toBeDefined();
    },
  );
});
