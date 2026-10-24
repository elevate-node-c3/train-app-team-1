import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { GatewayController } from './transport/gateway.controller.js';
import { GatewayService } from './domain/gateway.service.js';
import { GatewayRepository } from './persistence/gateway.repository.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
  ],
  controllers: [GatewayController],
  providers: [GatewayService, GatewayRepository],
  exports: [GatewayService],
})
export class GatewayModule {}
