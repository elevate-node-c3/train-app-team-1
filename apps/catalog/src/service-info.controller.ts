import { Controller, Get, Optional } from '@nestjs/common';
import { CacheMetrics } from '@app/common';

@Controller('catalog')
export class ServiceInfoController {
  constructor(@Optional() private readonly metrics?: CacheMetrics) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return { service: 'catalog', status: 'operational' };
  }

  @Get('cache/metrics')
  async getCacheMetrics() {
    return this.metrics ? await this.metrics.getSnapshotAsync() : null;
  }

  @Get('metrics')
  async getMetrics() {
    return this.metrics ? await this.metrics.getSnapshotAsync() : null;
  }
}
