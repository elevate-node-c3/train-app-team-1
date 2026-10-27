import { getProtoPath } from '../proto-path.js';

export const AUTH_PACKAGE_NAME = 'train.auth.v1';
export const AUTH_SERVICE_NAME = 'AuthService';

/** Resolves auth.proto across the source, dist and container layouts. */
export function getAuthProtoPath(): string {
  return getProtoPath('auth.proto');
}
