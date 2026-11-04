import { getProtoPath } from '../proto-path.js';

export const CATALOG_PACKAGE_NAME = 'train.catalog.v1';
export const CATALOG_SERVICE_NAME = 'CatalogService';

/** Resolves catalog.proto across the source, dist and container layouts. */
export function getCatalogProtoPath(): string {
  return getProtoPath('catalog.proto');
}
