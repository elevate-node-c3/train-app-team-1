import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { AuthError } from '../auth-error.js';
import { HoldPassengerTripKeyEntity } from '../entities/hold-passenger-trip-key.entity.js';

@Injectable()
export class HoldPassengerTripKeyRepository {
  async getOrPin(
    ctx: TransactionContext,
    tripId: string,
    activeVersion: number,
    keyFingerprint: string,
  ): Promise<HoldPassengerTripKeyEntity> {
    const manager = entityManagerOf(ctx);
    await manager.query(
      `INSERT INTO hold_passenger_trip_key (trip_id, key_version, key_fingerprint)
       VALUES ($1, $2, $3) ON CONFLICT (trip_id) DO NOTHING`,
      [tripId, activeVersion, keyFingerprint],
    );
    // A separate READ COMMITTED statement sees the concurrent insert winner.
    const pin = await manager.findOneBy(HoldPassengerTripKeyEntity, { tripId });
    if (!pin) throw new AuthError(ErrorCode.SERVICE_UNAVAILABLE);
    return pin;
  }
}
