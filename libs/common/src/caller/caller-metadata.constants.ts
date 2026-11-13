export const CALLER_ACCOUNT_ID_KEY = 'caller.accountId';
export const CALLER_SESSION_ID_KEY = 'caller.sessionId';
export const CALLER_JTI_KEY = 'caller.jti';
export const CALLER_ROLES_KEY = 'caller.roles';
export const CALLER_BOOKABLE_KEY = 'caller.bookable';
export const CALLER_ACCESS_LEVEL_KEY = 'caller.accessLevel';
export const CALLER_ACCESS_EXPIRES_AT_KEY = 'caller.accessExpiresAt';

export const CALLER_ACCOUNT_ID_HEADER = 'x-caller-account-id';
export const CALLER_SESSION_ID_HEADER = 'x-caller-session-id';
export const CALLER_JTI_HEADER = 'x-caller-jti';
export const CALLER_ROLES_HEADER = 'x-caller-roles';
export const CALLER_BOOKABLE_HEADER = 'x-caller-bookable';

/**
 * Only the gateway may set these headers after token verification. Strip
 * client-supplied values before any reader sees them.
 */
export const INTERNAL_CALLER_HEADER_PREFIXES = [
  'x-caller-',
  'x-internal-',
  'x-authenticated-',
] as const;
