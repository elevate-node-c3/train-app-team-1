import {
  DeleteResult,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
} from 'typeorm';

export interface repositoryInterface<T extends ObjectLiteral> {
  getModel(): Repository<T>;
  create(data: T): any;
  find(filter: FindManyOptions<T>): any;
  findOne(filter: FindOneOptions<T>): Promise<T | null>;
  findById(id: string): any;
  update(filter: any): any;
  delete(filter: FindOptionsWhere<T>): Promise<DeleteResult>;
}
