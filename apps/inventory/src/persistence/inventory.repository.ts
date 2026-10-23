import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class InventoryRepository {
  constructor(private readonly dataSource: DataSource) {}

  async ping(): Promise<boolean> {
    const result = await this.dataSource.query('SELECT 1');
    return Boolean(result);
  }
}
