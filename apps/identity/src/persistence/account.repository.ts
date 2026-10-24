import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ensureDataSourceInitialized } from '@app/common';
import { AccountEntity } from './entities/account.entity.js';

@Injectable()
export class AccountRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Finds an account by its lowercased email.
   * @returns the account, or null if none exists
   */
  async findByEmail(email: string): Promise<AccountEntity | null> {
    await ensureDataSourceInitialized(this.dataSource);
    return this.dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { email } });
  }
}
