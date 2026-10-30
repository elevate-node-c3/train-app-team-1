import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FareEntity } from './entities/fare.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([FareEntity])],
})
export class FaresModule {}