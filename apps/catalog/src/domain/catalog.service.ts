import { Injectable } from '@nestjs/common';
import { CatalogRepository } from '../persistence/catalog.repository.js';

@Injectable()
export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'catalog',
      status: 'operational',
    };
  }
}
