import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RecentSearchEntity } from './entities/recent-search.entity.js';
import { RecentSearchesGrpcController } from './recent-searches.grpc.controller.js';
import { RecentSearchesRepository } from './recent-searches.repository.js';
import { RecentSearchesService } from './recent-searches.service.js';

/**
 * Recent searches are per traveller; never mix them into the shared search cache.
 * Do not add CacheAsideService. Export the service so TripsModule can record searches.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RecentSearchEntity])],
  controllers: [RecentSearchesGrpcController],
  providers: [RecentSearchesRepository, RecentSearchesService],
  exports: [RecentSearchesService],
})
export class RecentSearchesModule {}
