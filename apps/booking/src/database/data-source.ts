import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '@app/common/config/database-url.js';
import { BookingDraftEntity } from '../modules/draft/entities/booking-draft.entity.js';
import { migrations } from './migrations/index.js';

export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [BookingDraftEntity],
  migrations,
});
