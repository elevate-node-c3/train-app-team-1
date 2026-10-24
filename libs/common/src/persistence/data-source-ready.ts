import type { DataSource } from 'typeorm';

const initializing = new WeakMap<DataSource, Promise<DataSource>>();

/**
 * Connects a `manualInitialization` DataSource on first use. Concurrent
 * callers share one initialize(), since TypeORM marks it initialized before
 * the schema is ready.
 * @returns the DataSource, ready to query
 */
export async function ensureDataSourceInitialized(
  dataSource: DataSource,
): Promise<DataSource> {
  const inFlight = initializing.get(dataSource);
  if (inFlight) {
    return inFlight;
  }
  if (dataSource.isInitialized) {
    return dataSource;
  }

  const attempt = dataSource.initialize().finally(() => {
    initializing.delete(dataSource);
  });
  initializing.set(dataSource, attempt);
  return attempt;
}
