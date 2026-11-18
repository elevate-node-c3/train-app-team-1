import type { MigrationInterface } from 'typeorm';
import { CreatePaymentCharges1795000000001 } from './1795000000001-create-payment-charges.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreatePaymentCharges1795000000001,
];
