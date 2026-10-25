import { Module } from '@nestjs/common';
import { DependencyHealthRegistry } from './dependency-health.js';

/**
 * Holds the registry alone, so a library that reports a dependency can import
 * it without pulling in `HealthModule` — and without `HealthModule` having to
 * import that library back.
 *
 * Not `@Global()`: Nest instantiates a module once per graph, so every importer
 * shares this instance already.
 */
@Module({
  providers: [DependencyHealthRegistry],
  exports: [DependencyHealthRegistry],
})
export class HealthRegistryModule {}
