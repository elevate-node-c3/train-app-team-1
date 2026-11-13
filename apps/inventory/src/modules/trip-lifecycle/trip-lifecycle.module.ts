import { Module } from '@nestjs/common';
import { MessagingModule } from '@app/messaging';

import { TripLifecycleTopologyService } from './trip-lifecycle.topology.js';

/** Hold early trip events until a consumer is available. */
@Module({
  imports: [MessagingModule],
  providers: [TripLifecycleTopologyService],
  exports: [TripLifecycleTopologyService],
})
export class TripLifecycleModule {}
