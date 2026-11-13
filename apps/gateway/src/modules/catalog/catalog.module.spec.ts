import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import { CatalogModule } from './catalog.module.js';
import { CATALOG_GRPC_CLIENT } from './catalog.types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the gateway catalog module', () => {
  it('declares the controller and both services', () => {
    const controllers = Reflect.getMetadata('controllers', CatalogModule) as
      unknown[] | undefined;
    const providers = Reflect.getMetadata('providers', CatalogModule) as
      unknown[] | undefined;

    expect(controllers).toContain(CatalogController);
    expect(providers).toContain(CatalogService);
    expect(providers).toContain(CatalogGrpcClientService);
    // Inject a ready proxy instead of unwrapping ClientGrpc in the service.
    expect(
      providers?.some(
        (provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          (provider as { provide?: unknown }).provide === CATALOG_GRPC_CLIENT,
      ),
    ).toBe(true);
  });

  /** Searching must stay independent of identity's client during outages. */
  it('reaches nothing in identity, so identity cannot break search', () => {
    const offenders: string[] = [];

    for (const file of filesUnder(MODULE_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*identity[^'"]*['"]/.test(source)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
