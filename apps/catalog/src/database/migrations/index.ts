import type { MigrationInterface } from 'typeorm';

import { CreateStationCatalog1793292475941 } from './1793292475941-create-station-catalog.js';

import { CreateCatalogTrainTables1793300000000 } from './1793300000000-create-catalog-train-tables.js';

import { CreateCatalogScheduleFareTripTables1793300000001 } from './1793300000001-create-catalog-schedule-fare-trip-tables.js';

import { AddTripSearchIndexes1793300000002 } from './1793300000002-add-trip-search-indexes.js';

import { CreateRecentSearch1793300000003 } from './1793300000003-create-recent-search.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreateStationCatalog1793292475941,
  CreateCatalogTrainTables1793300000000,
  CreateCatalogScheduleFareTripTables1793300000001,
  AddTripSearchIndexes1793300000002,
  CreateRecentSearch1793300000003,
];
