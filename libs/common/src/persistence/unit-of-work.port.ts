/**
 * The transaction boundary, as the application layer sees it.
 *
 * This file deliberately imports nothing. A use-case needs to run several
 * repository writes in one transaction (ADR-0001: the outbox row and the
 * business change commit together or not at all) without knowing that TypeORM
 * exists. Import it by subpath — `@app/common/persistence/unit-of-work.port.js`
 * — never through the `@app/common` barrel, which re-exports TypeORM-aware
 * modules and would drag the ORM into the application layer.
 */

/**
 * An open transaction, opaque on purpose.
 *
 * The application layer can hold one and pass it to a port, and can do nothing
 * else with it. Only an infrastructure adapter can read what is inside, so a
 * use-case cannot accidentally issue a query outside the transaction it was
 * given.
 */
export interface TransactionContext {
  /**
   * Identifies which adapter opened this context. An adapter checks it before
   * unwrapping, so mixing two unit-of-work implementations fails loudly
   * instead of silently running work on the wrong connection.
   */
  readonly driver: string;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWorkPort {
  /**
   * Runs `work` inside one transaction. Commits when it resolves, rolls back
   * when it rejects, and rethrows either way — a use-case must never discover
   * a rollback by checking a return value.
   */
  withTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
