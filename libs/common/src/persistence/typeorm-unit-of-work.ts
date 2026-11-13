import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from './unit-of-work.port.js';
import { DataSourceInitializer } from './data-source-initializer.js';

const DRIVER = 'typeorm';

/**
 * Holds the EntityManager for repositories to unwrap with entityManagerOf().
 * Use-cases see only the opaque TransactionContext.
 */
class TypeOrmTransactionContext implements TransactionContext {
  readonly driver = DRIVER;

  constructor(readonly manager: EntityManager) {}
}

/**
 * Unwraps a context opened by {@link TypeOrmUnitOfWork}.
 * Rejects other adapters' contexts instead of opening a second connection,
 * which would split domain and outbox writes across transactions.
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
    // Share initialization with readiness and migrations to avoid races.
    const dataSource = await this.initializer.ensureInitialized();
    return dataSource.transaction((manager) =>
      work(new TypeOrmTransactionContext(manager)),
    );
  }
}
