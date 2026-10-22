import { Module } from '@nestjs/common';
import { MyAppController } from './api_gateway.controller.js';
import { MyAppService } from './api_gateway.service.js';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['.env.dev', '.env.prod'],
    }),
  ],
  controllers: [MyAppController],
  providers: [MyAppService],
})
export class MyAppModule {}
