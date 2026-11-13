import { CacheAsideService } from '@app/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { RecentSearchEntity } from './entities/recent-search.entity.js';
import { RecentSearchesGrpcController } from './recent-searches.grpc.controller.js';
import { RecentSearchesModule } from './recent-searches.module.js';
import { RecentSearchesRepository } from './recent-searches.repository.js';
import { RecentSearchesService } from './recent-searches.service.js';
import { DatedTripEntity } from '../trips/entities/dated-trip.entity.js';
import { TripStopEntity } from '../trips/entities/trip-stop.entity.js';
import { CatalogModule } from '../../catalog.module.js';

/**
 * Compile CatalogModule because DataSource comes from TypeORM's root module.
 * Do not fake a feature-only graph that the application never builds.
 */
describe('the recent-searches module wiring', () => {
  async function compile() {
    return Test.createTestingModule({ imports: [CatalogModule] })
      .overrideProvider(DataSource)
      .useValue({
        options: { type: 'postgres' },
        entityMetadatas: [],
        getRepository: () => ({}),
        getMongoRepository: () => ({}),
        query: async () => [],
        transaction: async () => undefined,
      })
      .overrideProvider(getRepositoryToken(RecentSearchEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(DatedTripEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(TripStopEntity))
      .useValue({})
      .overrideProvider(CacheAsideService)
      .useValue({
        get: async () => null,
        set: async () => undefined,
        del: async () => undefined,
      })
      .compile();
  }

  it('constructs the service and its repository', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(RecentSearchesService)).toBeInstanceOf(
      RecentSearchesService,
    );
    expect(moduleRef.get(RecentSearchesRepository)).toBeInstanceOf(
      RecentSearchesRepository,
    );
  });

  it('registers the gRPC controller with the traveller it reads', async () => {
    const moduleRef = await compile();

    const controller = moduleRef.get(RecentSearchesGrpcController);

    expect(controller).toBeInstanceOf(RecentSearchesGrpcController);
    // Check that the controller receives this service, not just that both exist.
    expect(
      (controller as unknown as { recentSearches?: unknown }).recentSearches,
    ).toBeInstanceOf(RecentSearchesService);
  });

  /**
   * Recent searches must not use shared keys or enter the shared search cache.
   * Check declarations: CacheAsideService is global, so container resolution alone
   * cannot prove this feature does not depend on it.
   */
  it('declares no cache dependency anywhere in the feature', () => {
    const dependenciesOf = (target: unknown): unknown[] =>
      (Reflect.getMetadata('design:paramtypes', target as object) ??
        []) as unknown[];

    for (const injectable of [
      RecentSearchesService,
      RecentSearchesRepository,
      RecentSearchesGrpcController,
    ]) {
      expect(dependenciesOf(injectable)).not.toContain(CacheAsideService);
    }

    const declared = [
      ...((Reflect.getMetadata('imports', RecentSearchesModule) ??
        []) as unknown[]),
      ...((Reflect.getMetadata('providers', RecentSearchesModule) ??
        []) as unknown[]),
    ];
    expect(declared).not.toContain(CacheAsideService);
  });
});
