import { Injectable } from '@nestjs/common';
import { InventoryRepository } from '../persistence/inventory.repository.js';

@Injectable()
export class InventoryService {
  constructor(private readonly repository: InventoryRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'inventory',
      status: 'operational',
    };
  }
}
