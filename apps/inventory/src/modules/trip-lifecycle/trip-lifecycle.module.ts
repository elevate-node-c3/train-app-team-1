import { Module } from '@nestjs/common';
import { MessagingModule } from '@app/messaging';

import { TripLifecycleTopologyService } from './trip-lifecycle.topology.js';

/**
 * Inventory's half of CAT-2's trip events. For now it only declares the queue
 * so nothing published before Sprint 3 is lost; the handler that creates the
 * seats subscribes to the same queue later.
 */
@Module({
  imports: [MessagingModule],
  providers: [TripLifecycleTopologyService],
  exports: [TripLifecycleTopologyService],
})
export class TripLifecycleModule {}
