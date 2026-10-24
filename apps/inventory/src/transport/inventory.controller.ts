import { Controller, Get } from '@nestjs/common';
import { InventoryService } from '../domain/inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.inventoryService.getInfo();
  }
}
