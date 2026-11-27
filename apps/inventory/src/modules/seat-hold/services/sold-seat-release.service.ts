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
      const occupationId = await this.repository.findSoldOccupationId(ctx, input);
      if (!occupationId) return 'ALREADY_RELEASED';
      return (await this.repository.releaseSoldOccupation(ctx, occupationId))
        ? 'RELEASED'
        : 'ALREADY_RELEASED';
    });
  }
}
