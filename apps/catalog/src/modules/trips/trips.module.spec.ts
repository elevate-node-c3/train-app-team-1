import { CacheAsideService } from '@app/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { TripSearchService } from './trip-search.service.js';
import { TripsGrpcController } from './trips.grpc.controller.js';
import { CatalogModule } from '../../catalog.module.js';

/**
 * The wiring, which no unit spec can reach.
 *
 * Every spec above builds its subject with `new`, so a provider missing from
 * the module is invisible to all of them and shows up as a container failure
 * when catalog boots. Compiling the module here turns that into a test
 * failure instead.
 *
 * The whole CatalogModule is compiled rather than TripsModule alone, because
 * `DataSource` comes from TypeORM's root module and `CacheAsideService` from
 * the global RedisModule -- neither exists in an isolated feature module, and
 * a spec that provided them itself would be testing a graph the application
 * never builds. Compiling does not run lifecycle hooks, so nothing connects;
 * the infrastructure is overridden so nothing tries to.
 */
describe('the trips module wiring', () => {
  async function compile() {
    return Test.createTestingModule({ imports: [CatalogModule] })
      .overrideProvider(DataSource)
      // Enough surface for @nestjs/typeorm's repository factories, which every
      // feature module's forFeature() registers -- not just this one's.
      .useValue({
        options: { type: 'postgres' },
        entityMetadatas: [],
        getRepository: () => ({}),
        getMongoRepository: () => ({}),
        query: async () => [],
      })
      .overrideProvider(getRepositoryToken(DatedTripEntity))
      .useValue({})
      .overrideProvider(getRepositoryToken(TripStopEntity))
      .useValue({})
      .overrideProvider(CacheAsideService)
      .useValue({ get: async () => null, set: async () => undefined })
      .compile();
  }

  it('can construct the search service with all four collaborators', async () => {
    const moduleRef = await compile();

    const service = moduleRef.get(TripSearchService);

    expect(service).toBeInstanceOf(TripSearchService);
  });

  it('gives the gRPC controller the search service', async () => {
    const moduleRef = await compile();

    const controller = moduleRef.get(TripsGrpcController);

    // Asserted on the controller's own dependency: resolving the token
    // container-wide would find a provider in any module, which says nothing
    // about whether this controller can inject it.
    expect(
      (controller as unknown as { search?: unknown }).search,
    ).toBeInstanceOf(TripSearchService);
  });

  it('provides both repositories and the availability seam', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(TripSearchRepository)).toBeInstanceOf(
      TripSearchRepository,
    );
    expect(moduleRef.get(CatalogReferenceRepository)).toBeInstanceOf(
      CatalogReferenceRepository,
    );
    expect(moduleRef.get(SeatAvailabilityService)).toBeInstanceOf(
      SeatAvailabilityService,
    );
  });
});
