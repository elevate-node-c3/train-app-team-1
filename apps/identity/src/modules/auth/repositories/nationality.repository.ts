import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NationalityEntity } from '../entities/nationality.entity.js';

@Injectable()
export class NationalityRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findAll(): Promise<NationalityEntity[]> {
    return this.dataSource.getRepository(NationalityEntity).find();
  }

  async findByCode(code: string): Promise<NationalityEntity | null> {
    return this.dataSource
      .getRepository(NationalityEntity)
      .findOne({ where: { code } });
  }
}

