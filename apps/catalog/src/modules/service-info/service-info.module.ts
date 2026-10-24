import { Module } from '@nestjs/common';
import { ServiceInfoService } from './application/service-info.service.js';
import { ServiceInfoHttpController } from './presentation/http/service-info.http.controller.js';

@Module({
  controllers: [ServiceInfoHttpController],
  providers: [ServiceInfoService],
})
export class ServiceInfoModule {}
