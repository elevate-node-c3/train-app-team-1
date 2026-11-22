import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { MigrationRunnerService } from '@app/common';
import { EventConsumerService } from '@app/messaging';
import { BookingModule } from '../../../apps/booking/src/booking.module.js';
import { BookingFlowRepository } from '../../../apps/booking/src/modules/flow/booking-flow.repository.js';

// Observe actual completed broker deliveries, including the deduplication path.
// oxlint-disable-next-line typescript/unbound-method -- Rebound to the actual consumer below.
const handleMessage = EventConsumerService.prototype.handleMessage;
EventConsumerService.prototype.handleMessage = async function (
  subscription,
  message,
  channel,
) {
  await handleMessage.call(this, subscription, message, channel);
  process.send?.({
    type: 'delivery',
    eventId: message.properties.messageId,
    contentHash: createHash('sha256').update(message.content).digest('hex'),
  });
};

// oxlint-disable-next-line typescript/unbound-method -- Rebound to the actual repository below.
const recordSettlement = BookingFlowRepository.prototype.recordSettlement;
BookingFlowRepository.prototype.recordSettlement = async function (...args) {
  if (args[0] === process.env.CONFIRMATION_CRASH_BOOKING_ID) {
    // Inventory has committed and gRPC returned, but booking has not persisted
    // the result. Never resolve: the parent must terminate this OS process.
    process.send?.({ type: 'before-settlement-record', bookingId: args[0] });
    await new Promise<void>(() => {});
  }
  return recordSettlement.apply(this, args);
};

async function bootstrap(): Promise<void> {
  // Real production module: migrations, leased worker, gRPC clients, AMQP
  // consumer and outbox lifecycle hooks. No test calls to worker.scan/run.
  const app = await NestFactory.createApplicationContext(BookingModule, {
    logger: false,
  });
  if (!app.get(MigrationRunnerService).hasCompleted)
    throw new Error('Schema bootstrap failed.');
  process.send?.({ type: 'ready', pid: process.pid });
  process.on('message', (message: { type?: string }) => {
    if (message.type === 'close') void app.close().then(() => process.exit(0));
  });
}

bootstrap().catch(() => {
  // Configuration and raw driver errors can contain credentials. IPC reports
  // only a fixed failure code; raw child output is never exposed by the parent.
  process.send?.({ type: 'bootstrap-failed' });
  process.exit(1);
});
