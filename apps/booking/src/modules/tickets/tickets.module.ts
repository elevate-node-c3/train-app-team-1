import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TicketEntity } from '../flow/entities/ticket.entity.js';
import { TicketSignerService } from './services/ticket-signer.service.js';
import { TicketsService } from './services/tickets.service.js';
import { TicketsGrpcController } from './tickets.grpc.controller.js';
import { TicketsRepository } from './tickets.repository.js';

/**
 * TA-108: what happens to a ticket after the confirmation saga issues it --
 * the traveller's lists, the signed QR, the share link, the PDF and the
 * conductor's check.
 *
 * The saga issues through TicketIssuerService, which signs each QR with the
 * signer exported here: the private key has exactly one holder.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TicketEntity])],
  controllers: [TicketsGrpcController],
  providers: [TicketsRepository, TicketsService, TicketSignerService],
  exports: [TicketSignerService],
})
export class TicketsModule {}
