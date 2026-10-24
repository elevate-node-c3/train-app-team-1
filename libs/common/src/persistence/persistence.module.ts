import { Global, Module } from '@nestjs/common';
import { DataSourceInitializer } from './data-source-initializer.js';

/**
 * `@Global()` on purpose, and this is the one place in the platform where it
 * is justified: `DataSourceInitializer` only works if there is exactly **one**
 * of it. Its whole job is to hold the single in-flight `initialize()` promise
 * so the readiness probe, the unit of work and the migration runner cannot
 * race each other. Providing it in two modules would give two instances, two
 * promises, and the `CannotConnectAlreadyConnectedError` it exists to prevent.
 *
 * Making it global is what lets a feature module bind
 * `{ provide: UNIT_OF_WORK, useClass: TypeOrmUnitOfWork }` without importing
 * persistence plumbing it should not know about.
 */
@Global()
@Module({
  providers: [DataSourceInitializer],
  exports: [DataSourceInitializer],
})
export class PersistenceModule {}
