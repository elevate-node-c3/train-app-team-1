import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProfileTypeEntity } from '../entities/profile-type.entity.js';

@Injectable()
export class ProfileTypeRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findAll(): Promise<ProfileTypeEntity[]> {
    return this.dataSource.getRepository(ProfileTypeEntity).find();
  }

  async findByCode(code: string): Promise<ProfileTypeEntity | null> {
    return this.dataSource
      .getRepository(ProfileTypeEntity)
      .findOne({ where: { code } });
  }
}
