import { Module } from '@nestjs/common';
import { MessagingModule } from '@app/messaging';

import { TripLifecycleTopologyService } from './trip-lifecycle.topology.js';

/**
 * Declares the queue now so early trip events are held until Sprint 3's
 * handler arrives.
 */
@Module({
  imports: [MessagingModule],
  providers: [TripLifecycleTopologyService],
  exports: [TripLifecycleTopologyService],
})
export class TripLifecycleModule {}
