import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from './unit-of-work.port.js';

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
  private readonly logger = new Logger(TypeOrmUnitOfWork.name);

  /**
   * Serialises concurrent first-use. `manualInitialization: true` means Nest
   * never connects the DataSource, so whoever needs it first must — and two
   * callers racing to `initialize()` throws CannotConnectAlreadyConnectedError.
   * One shared promise makes every caller after the first await the same
   * attempt. It is cleared on failure so a Postgres outage is retried rather
   * than cached forever.
   */
  private initializing: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async withTransaction<T>(
    work: (ctx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    await this.ensureInitialized();
    return this.dataSource.transaction((manager) =>
      work(new TypeOrmTransactionContext(manager)),
    );
  }

  private async ensureInitialized(): Promise<void> {
    if (this.dataSource.isInitialized) {
      return;
    }
    this.initializing ??= this.dataSource
      .initialize()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.initializing = null;
        this.logger.error(
          { err: error },
          'failed to initialize the data source',
        );
        throw error;
      });
    await this.initializing;
  }
}
