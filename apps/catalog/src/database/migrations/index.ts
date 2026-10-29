import type { MigrationInterface } from 'typeorm';
import { CreateStationCatalog1793292475941 } from './1793292475941-create-station-catalog.js';

export const migrations: (new () => MigrationInterface)[] = [
  CreateStationCatalog1793292475941,
];