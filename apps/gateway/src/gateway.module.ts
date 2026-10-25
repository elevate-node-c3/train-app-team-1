import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { GatewayController } from './gateway.controller.js';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { GatewayService } from './gateway.service.js';
import { IdentityModule } from './module/identity/identity.module.js';
import { ClientsModule, Transport } from '@nestjs/microservices';
import path from 'node:path';
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
    ConfigModule.forRoot({
      envFilePath: ['.env.example'],
    }),
    ClientsModule.register([
      {
        name: 'IDENTITY_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'Identity',
          protoPath: path.join(__dirname, '../proto/identity.proto'),
          url: 'localhost:50051',
        },
      },
    ]),
    // global endpoints ratelimiting
    // ThrottlerModule.forRoot({
    //   throttlers: [
    //     {
    //       ttl: 60000,
    //       limit: 10,
    //     },
    //   ],
    // }),
    IdentityModule,
  ],
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule {}
