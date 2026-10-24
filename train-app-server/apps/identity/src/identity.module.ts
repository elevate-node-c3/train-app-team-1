import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entity/user.entity.js';
import { OutboxEvent } from './entity/outbox-event.entity.js';
import { VerificationCode } from './entity/verification-code.entity.js';
import { RedisService } from './redis/redis.service.js';

@Module({
  imports: [

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env.dev',
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),

    TypeOrmModule.forFeature([User, VerificationCode, OutboxEvent]),
  ],
  controllers: [IdentityController],
  providers: [IdentityService,RedisService],
})
export class IdentityModule {}
