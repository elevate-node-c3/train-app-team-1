/**
 * The transaction boundary, as the application layer sees it (ADR-0001). Imports
 * nothing on purpose. Import it by subpath, never through the `@app/common`
 * barrel, which would drag TypeORM into the application layer.
 */

/** An open transaction. Opaque, so a use-case cannot query outside it. */
export interface TransactionContext {
  /** Which adapter opened this, checked before unwrapping so a mismatch is loud. */
  readonly driver: string;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWorkPort {
  /** Commits on resolve, rolls back on reject, and always rethrows. */
  withTransaction<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
