import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { IdentityController } from './transport/identity.controller.js';
import { IdentityService } from './domain/identity.service.js';
import { IdentityRepository } from './persistence/identity.repository.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
  ],
  controllers: [IdentityController],
  providers: [IdentityService, IdentityRepository],
  exports: [IdentityService],
})
export class IdentityModule {}
