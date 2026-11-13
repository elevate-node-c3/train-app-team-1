import { Module } from '@nestjs/common';
import { DependencyHealthRegistry } from './dependency-health.js';

/**
 * Keeps dependency registration separate from HealthModule to avoid cycles.
 * Nest shares one instance per module graph without `@Global()`.
 */
@Module({
  providers: [DependencyHealthRegistry],
  exports: [DependencyHealthRegistry],
})
export class HealthRegistryModule {}
