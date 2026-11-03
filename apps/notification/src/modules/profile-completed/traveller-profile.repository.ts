import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TravellerProfileEntity } from './entities/traveller-profile.entity.js';

@Injectable()
export class TravellerProfileRepository {
  constructor(private readonly dataSource: DataSource) {}

  async upsert(accountId: string, fullName: string, now: Date = new Date()): Promise<void> {
    await this.dataSource
      .getRepository(TravellerProfileEntity)
      .createQueryBuilder()
      .insert()
      .into(TravellerProfileEntity)
      .values({
        accountId,
        fullName,
        createdAt: now,
        updatedAt: now,
      })
      .orUpdate(['full_name', 'updated_at'], ['account_id'])
      .execute();
  }

  async findByAccountId(accountId: string): Promise<TravellerProfileEntity | null> {
    return this.dataSource
      .getRepository(TravellerProfileEntity)
      .findOne({ where: { accountId } });
  }
}

