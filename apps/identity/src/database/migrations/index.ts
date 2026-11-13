import { CreateAccountsVerificationCodesOutbox1761314400000 } from './1761314400000-create-accounts-verification-codes-outbox.js';
import { CreateAuthSessions1761314600000 } from './1761314600000-create-auth-sessions.js';
import { CreateProfilePassengers1761314700000 } from './1761314700000-create-profile-passengers.js';
import { EnforcePassengerLimitAndTypes1761314900000 } from './1761314900000-enforce-passenger-limit-and-types.js';

export const migrations = [
  CreateAccountsVerificationCodesOutbox1761314400000,
  CreateAuthSessions1761314600000,
  CreateProfilePassengers1761314700000,
  EnforcePassengerLimitAndTypes1761314900000,
];

export const IDENTITY_MIGRATIONS = migrations;

export {
  CreateAccountsVerificationCodesOutbox1761314400000,
  CreateAuthSessions1761314600000,
  CreateProfilePassengers1761314700000,
  EnforcePassengerLimitAndTypes1761314900000,
};
