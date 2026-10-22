import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import * as catalogModule from '../../apps/catalog/src/catalog.module.ts';
import * as gatewayModule from '../../apps/gateway/src/gateway.module.ts';
import * as identityModule from '../../apps/identity/src/identity.module.ts';
import * as inventoryModule from '../../apps/inventory/src/inventory.module.ts';
import * as bookingModule from '../../apps/booking/src/booking.module.ts';
import * as paymentModule from '../../apps/payment/src/payment.module.ts';
import * as notificationModule from '../../apps/notification/src/notification.module.ts';

const SERVICES = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;

// Vite cannot statically analyze a dynamic import with two interpolations
// (`../../apps/${service}/src/${service}.module.ts`) — it throws "Unknown
// variable dynamic import" for every case. A static map of the same seven
// modules tests the same behavior (each module compiles standalone).
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

  it.each(SERVICES)(
    '%s has a module that compiles on its own',
    async (service) => {
      const pascal = service[0].toUpperCase() + service.slice(1);
      const mod = MODULES[service];
      const moduleClass = mod[`${pascal}Module`];
      expect(moduleClass).toBeDefined();
      await expect(
        Test.createTestingModule({ imports: [moduleClass] }).compile(),
      ).resolves.toBeDefined();
    },
  );
});
