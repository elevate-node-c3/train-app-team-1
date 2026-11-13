import type { MigrationInterface } from 'typeorm';

import { CreateInventoryOutbox1794600000000 } from './1794600000000-create-inventory-outbox.js';
import { CreateInventoryProcessedEvent1794600000001 } from './1794600000001-create-inventory-processed-event.js';
import { CreateInventoryTripTables1794600000002 } from './1794600000002-create-inventory-trip-tables.js';
import { AddTripSeatTripUnique1794600000003 } from './1794600000003-add-trip-seat-trip-unique.js';
import { CreateSeatOccupation1794600000004 } from './1794600000004-create-seat-occupation.js';
import { AddTripTimetableVersion1794600000005 } from './1794600000005-add-trip-timetable-version.js';
import { AddTripStopTimes1794600000006 } from './1794600000006-add-trip-stop-times.js';

// Keep migration timestamps unique; TypeORM keys migrations by name.
export const migrations: (new () => MigrationInterface)[] = [
  CreateInventoryOutbox1794600000000,
  CreateInventoryProcessedEvent1794600000001,
  CreateInventoryTripTables1794600000002,
  AddTripSeatTripUnique1794600000003,
  CreateSeatOccupation1794600000004,
  AddTripTimetableVersion1794600000005,
  AddTripStopTimes1794600000006,
];
