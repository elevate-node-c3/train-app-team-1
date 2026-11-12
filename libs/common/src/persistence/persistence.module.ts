import { Global, Module } from '@nestjs/common';
import { DataSourceInitializer } from './data-source-initializer.js';
import { SchemaReadinessGate } from './schema-readiness.gate.js';

/**
 * Global so feature modules share one DataSourceInitializer and one
 * SchemaReadinessGate. Duplicate instances would race initialization or leave
 * background work waiting on a gate that nobody opens.
 */
@Global()
@Module({
  providers: [DataSourceInitializer, SchemaReadinessGate],
  exports: [DataSourceInitializer, SchemaReadinessGate],
})
export class PersistenceModule {}
