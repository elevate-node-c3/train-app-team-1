import { CreateAccountsVerificationCodesOutbox1761314400000 } from './1761314400000-create-accounts-verification-codes-outbox.js';
import { CreateAuthSessions1761314600000 } from './1761314600000-create-auth-sessions.js';

/**
 * Explicit ordering. TypeORM also sorts by the class-name timestamp, but an
 * explicit array is what the migration test inspects and what a reviewer reads.
 */
export const migrations = [
  CreateAccountsVerificationCodesOutbox1761314400000,
  CreateAuthSessions1761314600000,
];

export {
  CreateAccountsVerificationCodesOutbox1761314400000,
  CreateAuthSessions1761314600000,
};
