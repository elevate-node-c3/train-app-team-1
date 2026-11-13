import type { MigrationInterface } from 'typeorm';

import { CreateInventoryOutbox1794600000000 } from './1794600000000-create-inventory-outbox.js';
import { CreateInventoryProcessedEvent1794600000001 } from './1794600000001-create-inventory-processed-event.js';

// Keep migration timestamps unique; TypeORM keys migrations by name.
export const migrations: (new () => MigrationInterface)[] = [
  CreateInventoryOutbox1794600000000,
  CreateInventoryProcessedEvent1794600000001,
];
