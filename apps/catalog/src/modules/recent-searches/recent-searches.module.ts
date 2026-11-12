import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RecentSearchEntity } from './entities/recent-search.entity.js';
import { RecentSearchesGrpcController } from './recent-searches.grpc.controller.js';
import { RecentSearchesRepository } from './recent-searches.repository.js';
import { RecentSearchesService } from './recent-searches.service.js';

/**
 * A traveller's recent searches.
 *
 * `CacheAsideService` is conspicuously absent, and that is the design. Recent
 * searches are per traveller, so there is no correct shared key for them
 * (§2.3 rule 6); not importing the dependency means no future change can
 * quietly add one without this module declaring it. The spec beside this file
 * asserts the absence, so the decision is enforced rather than remembered.
 *
 * Exported for `TripsModule`, which records a search after answering one.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RecentSearchEntity])],
  controllers: [RecentSearchesGrpcController],
  providers: [RecentSearchesRepository, RecentSearchesService],
  exports: [RecentSearchesService],
})
export class RecentSearchesModule {}
