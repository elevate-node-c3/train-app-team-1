import {
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import { revokeTokenModel } from '../../database/revokeToken.model.js';
import { repositoryInterface } from '../interfaces/repository.interface.js';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class revokeTokenRepo implements repositoryInterface<revokeTokenModel> {
  constructor(
    @InjectRepository(revokeTokenModel)
    private _model: Repository<revokeTokenModel>,
  ) {}
  getModel() {
    return this._model;
  }
  create(data: revokeTokenModel) {}

  async delete(filter: FindOptionsWhere<revokeTokenModel>) {
    return await this.getModel().delete(filter);
  }
  find(filter: FindManyOptions<revokeTokenModel>) {}
  findById(id: string) {}
  async findOne(filter: FindOneOptions<revokeTokenModel>) {
    return await this.getModel().findOne(filter);
  }
  update(filter: any) {}
}
