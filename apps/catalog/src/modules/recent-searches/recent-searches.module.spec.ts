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
 * The wiring, and one structural promise no unit spec can make.
 *
 * The whole CatalogModule is compiled rather than this module alone, for the
 * reason `trips.module.spec.ts` gives: `DataSource` comes from TypeORM's root
 * module, so an isolated feature module cannot resolve it, and a spec that
 * provided one itself would be testing a graph the application never builds.
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
    // Its own dependency, not a container-wide lookup: the controller has to
    // be able to inject the service, not merely coexist with one.
    expect(
      (controller as unknown as { recentSearches?: unknown }).recentSearches,
    ).toBeInstanceOf(RecentSearchesService);
  });

  /**
   * §2.3 rule 6: recent searches are never cached under a shared key and never
   * mixed into the shared search cache.
   *
   * Asserted against the declarations rather than the container, because the
   * container is a liar here -- `CacheAsideService` is global, so resolving it
   * succeeds from anywhere. What matters is that nothing in this feature *asks*
   * for it, and a later change has to delete this test to start.
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
