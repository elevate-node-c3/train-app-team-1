/**
 * Import this dependency-free port by subpath, not the `@app/common` barrel,
 * to keep TypeORM out of the application layer.
 */

/** An open transaction. Opaque, so a use-case cannot query outside it. */
export interface TransactionContext {
  /** Adapter identity, checked before unwrapping. */
  readonly driver: string;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWorkPort {
  /** Commits on resolve; rolls back and rethrows on rejection. */
  withTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
