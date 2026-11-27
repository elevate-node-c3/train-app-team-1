import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';

import {
  HoldCoreRepository,
  type SoldSeatReleaseLookup,
} from '../hold-core.repository.js';

export type SoldSeatReleaseInput = SoldSeatReleaseLookup;

/** Frees one passenger's sold seat when booking cancels that ticket. */
@Injectable()
export class SoldSeatReleaseService {
  constructor(
    private readonly repository: HoldCoreRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async release(
    input: SoldSeatReleaseInput,
  ): Promise<'RELEASED' | 'ALREADY_RELEASED'> {
    return this.unitOfWork.withTransaction(async (ctx) => {
      const occupationIds = await this.repository.findSoldOccupationIds(ctx, input);
      if (occupationIds.length === 0) return 'ALREADY_RELEASED';
      const released = await this.repository.releaseSoldOccupations(ctx, occupationIds);
      return released > 0 ? 'RELEASED' : 'ALREADY_RELEASED';
    });
  }
}
