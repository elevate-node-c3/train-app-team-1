import { Module } from '@nestjs/common';
import { RouteVersionService } from './route-version.service.js';

@Module({
  providers: [RouteVersionService],
  exports: [RouteVersionService],
})
export class CatalogCacheModule {}

