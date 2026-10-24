import { Controller, Get } from '@nestjs/common';
import { CatalogService } from '../domain/catalog.service.js';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.catalogService.getInfo();
  }
}
