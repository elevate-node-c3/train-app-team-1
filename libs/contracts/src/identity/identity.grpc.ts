import { getProtoPath } from '../proto-path.js';

export const IDENTITY_PACKAGE_NAME = 'train.identity.v1';
export const IDENTITY_SERVICE_NAME = 'IdentityService';

/** Resolves identity.proto across the source, dist and container layouts. */
export function getIdentityProtoPath(): string {
  return getProtoPath('identity.proto');
}
