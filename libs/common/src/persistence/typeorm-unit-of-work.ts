import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from './unit-of-work.port.js';
import { DataSourceInitializer } from './data-source-initializer.js';

const DRIVER = 'typeorm';

/**
 * The only object that may hold an EntityManager on behalf of the application
 * layer. Repositories unwrap it with `entityManagerOf()`; use-cases see the
 * `TransactionContext` interface and nothing more.
 */
class TypeOrmTransactionContext implements TransactionContext {
  readonly driver = DRIVER;

  constructor(readonly manager: EntityManager) {}
}

/**
 * Unwraps a context opened by {@link TypeOrmUnitOfWork}.
 *
 * Throws rather than returning null: being handed a context from a different
 * adapter means two unit-of-work implementations are wired at once, and
 * quietly opening a second connection would reintroduce exactly the dual-write
 * bug ADR-0001 removes.
 */
export function entityManagerOf(ctx: TransactionContext): EntityManager {
  if (!(ctx instanceof TypeOrmTransactionContext)) {
    throw new Error(
      `Expected a '${DRIVER}' transaction context, received '${ctx.driver}'`,
    );
  }
  return ctx.manager;
}

@Injectable()
export class TypeOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly initializer: DataSourceInitializer) {}

  async withTransaction<T>(
    work: (ctx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // Connecting is shared with the readiness probe and the migration runner,
    // because two callers racing to initialize() throws
    // CannotConnectAlreadyConnectedError.
    const dataSource = await this.initializer.ensureInitialized();
    return dataSource.transaction((manager) =>
      work(new TypeOrmTransactionContext(manager)),
    );
  }
}
