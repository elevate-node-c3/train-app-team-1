import { Module } from '@nestjs/common';
import { MyAppController } from './my-app.controller.js';
import { MyAppService } from './my-app.service.js';

@Module({
  imports: [],
  controllers: [MyAppController],
  providers: [MyAppService],
})
export class MyAppModule {}
