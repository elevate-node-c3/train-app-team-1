import type { MigrationInterface } from 'typeorm';

import { CreateStationCatalog1793292475941 } from './1793292475941-create-station-catalog.js';
import { CreateCatalogTrainTables1793300000000 } from './1793300000000-create-catalog-train-tables.js';
import { CreateCatalogScheduleFareTripTables1793300000001 } from './1793300000001-create-catalog-schedule-fare-trip-tables.js';
import { AddTripSearchIndexes1793300000002 } from './1793300000002-add-trip-search-indexes.js';
import { CreateRecentSearch1793300000003 } from './1793300000003-create-recent-search.js';
import { CreateCatalogOutbox1793300000004 } from './1793300000004-create-catalog-outbox.js';
import { CreateCatalogProcessedEvent1793300000005 } from './1793300000005-create-catalog-processed-event.js';
import { AddTimetableVersionConstraints1793300000006 } from './1793300000006-add-timetable-version-constraints.js';
import { CreateOperationsAudit1793300000007 } from './1793300000007-create-operations-audit.js';
import { CreateOperationsRequest1793300000008 } from './1793300000008-create-operations-request.js';

// Run order. Two migrations must never share a timestamp: TypeORM keys them by name.
export const migrations: (new () => MigrationInterface)[] = [
  CreateStationCatalog1793292475941,
  CreateCatalogTrainTables1793300000000,
  CreateCatalogScheduleFareTripTables1793300000001,
  AddTripSearchIndexes1793300000002,
  CreateRecentSearch1793300000003,
  CreateCatalogOutbox1793300000004,
  CreateCatalogProcessedEvent1793300000005,
  AddTimetableVersionConstraints1793300000006,
  CreateOperationsAudit1793300000007,
  CreateOperationsRequest1793300000008,
];
