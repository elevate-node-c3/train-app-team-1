import { CacheAsideService } from '@app/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { TripDayService } from './trip-day.service.js';
import { TripReturnSearchService } from './trip-return-search.service.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { TripSearchService } from './trip-search.service.js';
import { TripStopsRepository } from './trip-stops.repository.js';
import { TripStopsService } from './trip-stops.service.js';
import { TripsGrpcController } from './trips.grpc.controller.js';
import { CatalogModule } from '../../catalog.module.js';

/**
 * Compile CatalogModule to catch missing providers with the real module graph.
 * DataSource and CacheAsideService come from root/global modules, not isolated
 * features. Override infrastructure; compilation does not run lifecycle hooks
 * or connect to services.
 */
describe('the trips module wiring', () => {
  async function compile() {
    return (
      Test.createTestingModule({ imports: [CatalogModule] })
        .overrideProvider(DataSource)
        // Support repository factories registered by every feature's forFeature.
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
        .useValue({
          get: async () => null,
          set: async () => undefined,
          del: async () => undefined,
        })
        .compile()
    );
  }

  it('can construct the search service with all four collaborators', async () => {
    const moduleRef = await compile();

    const service = moduleRef.get(TripSearchService);

    expect(service).toBeInstanceOf(TripSearchService);
  });

  it('gives the gRPC controller all three services', async () => {
    const moduleRef = await compile();

    const controller = moduleRef.get(TripsGrpcController);

    // Check the controller's injected dependencies, not container-wide resolution.
    expect(
      (controller as unknown as { search?: unknown }).search,
    ).toBeInstanceOf(TripSearchService);
    expect(
      (controller as unknown as { returnSearch?: unknown }).returnSearch,
    ).toBeInstanceOf(TripReturnSearchService);
    expect((controller as unknown as { stops?: unknown }).stops).toBeInstanceOf(
      TripStopsService,
    );
  });

  /** Both legs must inject the same TripDayService to share cached days. */
  it('gives both search legs the same day service instance', async () => {
    const moduleRef = await compile();

    const day = moduleRef.get(TripDayService);
    const outbound = moduleRef.get(TripSearchService) as unknown as {
      day: unknown;
    };
    const returning = moduleRef.get(TripReturnSearchService) as unknown as {
      day: unknown;
    };

    expect(day).toBeInstanceOf(TripDayService);
    expect(outbound.day).toBe(day);
    expect(returning.day).toBe(day);
  });

  it('provides both repositories, the stops service and the availability seam', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(TripSearchRepository)).toBeInstanceOf(
      TripSearchRepository,
    );
    expect(moduleRef.get(TripStopsRepository)).toBeInstanceOf(
      TripStopsRepository,
    );
    expect(moduleRef.get(TripStopsService)).toBeInstanceOf(TripStopsService);
    expect(moduleRef.get(CatalogReferenceRepository)).toBeInstanceOf(
      CatalogReferenceRepository,
    );
    expect(moduleRef.get(SeatAvailabilityService)).toBeInstanceOf(
      SeatAvailabilityService,
    );
  });
});
