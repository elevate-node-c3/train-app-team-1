import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, createHmac } from 'node:crypto';
import {
  ErrorCode,
  type ResolveHoldPassengersRequest,
  type ResolveHoldPassengersResponse,
} from '@app/contracts';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  HOLD_PASSENGER_TOKEN_SETTINGS,
  type HoldPassengerTokenSettings,
} from '../../../config/hold-passenger-token-settings.js';
import { AuthError } from '../auth-error.js';
import { HoldPassengerTripKeyRepository } from '../repositories/hold-passenger-trip-key.repository.js';
import { PassengerRepository } from '../repositories/passenger.repository.js';
import { validateFullName } from '../validators/full-name.validator.js';
import { validateNationalId } from '../validators/national-id.validator.js';

@Injectable()
export class HoldPassengersService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly passengers: PassengerRepository,
    private readonly tripKeys: HoldPassengerTripKeyRepository,
    @Inject(HOLD_PASSENGER_TOKEN_SETTINGS)
    private readonly settings: HoldPassengerTokenSettings,
  ) {}

  async resolve(
    request: ResolveHoldPassengersRequest,
  ): Promise<ResolveHoldPassengersResponse> {
    if (
      !request ||
      typeof request.ownerId !== 'string' ||
      !isUUID(request.ownerId) ||
      !Array.isArray(request.passengerRefs) ||
      request.passengerRefs.length < 1 ||
      request.passengerRefs.length > 4 ||
      request.passengerRefs.some(
        (ref) => typeof ref !== 'string' || !isUUID(ref),
      ) ||
      !Array.isArray(request.tripIds) ||
      request.tripIds.length < 1 ||
      request.tripIds.length > 2 ||
      request.tripIds.some((id) => typeof id !== 'string' || !isUUID(id))
    ) {
      throw new AuthError(ErrorCode.BAD_REQUEST);
    }
    const refs = request.passengerRefs.map((ref) => ref.toLowerCase());
    const trips = request.tripIds.map((id) => id.toLowerCase());
    if (
      new Set(refs).size !== refs.length ||
      new Set(trips).size !== trips.length
    ) {
      throw new AuthError(ErrorCode.BAD_REQUEST);
    }

    const activeVersion = this.settings.activeVersion;
    const activeKey =
      activeVersion === null
        ? undefined
        : this.settings.keys.get(activeVersion);
    if (
      !activeVersion ||
      !Buffer.isBuffer(activeKey) ||
      activeKey.length < 32
    ) {
      throw new AuthError(ErrorCode.SERVICE_UNAVAILABLE);
    }
    const activeFingerprint = createHash('sha256')
      .update(activeKey)
      .digest('hex');

    try {
      return await this.unitOfWork.withTransaction(async (ctx) => {
        const selected = new Map<
          string,
          { displayName: string; nationalId: string }
        >();
        // Stable lock ordering also covers reversed passenger/round-trip requests.
        for (const ref of [...refs].sort()) {
          const passenger = await this.passengers.findByIdAndAccountId(
            ctx,
            ref,
            request.ownerId.toLowerCase(),
            { forUpdate: true },
          );
          if (!passenger) throw new AuthError(ErrorCode.PASSENGER_NOT_FOUND);
          const nationalId = validateNationalId(passenger.nationalId);
          if (!nationalId.valid) throw new AuthError(nationalId.errors[0]);
          const displayName = validateFullName(passenger.fullName);
          if (!displayName.valid)
            throw new AuthError(ErrorCode.INVALID_FULL_NAME);
          selected.set(ref, {
            displayName: displayName.normalized,
            nationalId: nationalId.normalized,
          });
        }

        const pinned = new Map<string, { keyVersion: number; key: Buffer }>();
        for (const tripId of [...trips].sort()) {
          const pin = await this.tripKeys.getOrPin(
            ctx,
            tripId,
            activeVersion,
            activeFingerprint,
          );
          const key = this.settings.keys.get(pin.keyVersion);
          if (
            !Buffer.isBuffer(key) ||
            key.length < 32 ||
            createHash('sha256').update(key).digest('hex') !==
              pin.keyFingerprint
          ) {
            throw new AuthError(ErrorCode.SERVICE_UNAVAILABLE);
          }
          pinned.set(tripId, { keyVersion: pin.keyVersion, key });
        }

        return {
          passengers: request.passengerRefs.map((passengerRef, index) => {
            const passenger = selected.get(refs[index])!;
            return {
              passengerRef,
              displayName: passenger.displayName,
              maskedNationalId: `**********${passenger.nationalId.slice(-4)}`,
              identities: request.tripIds.map((tripId, legIndex) => {
                const pin = pinned.get(trips[legIndex])!;
                return {
                  tripId,
                  passengerKeyVersion: pin.keyVersion,
                  passengerToken: createHmac('sha256', pin.key)
                    .update(
                      `hold-passenger:v1\0${trips[legIndex]}\0${passenger.nationalId}`,
                    )
                    .digest('hex'),
                };
              }),
            };
          }),
        };
      });
    } catch (error: unknown) {
      // Never expose database parameters, key material, or raw identity values.
      throw new AuthError(
        error instanceof AuthError ? error.code : ErrorCode.SERVICE_UNAVAILABLE,
      );
    }
  }
}
