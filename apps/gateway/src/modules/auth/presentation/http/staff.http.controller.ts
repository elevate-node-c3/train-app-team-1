import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RequireRole } from '@app/common';
import type { StaffRole } from '@app/contracts';

/**
 * BR-01's staff roles are separate capabilities, not ranks. These two routes
 * are the smallest real surface that proves the distinction: neither role can
 * reach the other's route, and a traveller token reaches neither.
 */
@Controller('auth/staff')
export class StaffHttpController {
  @RequireRole('operator')
  @Post('operator')
  @HttpCode(HttpStatus.OK)
  operator(): { role: Extract<StaffRole, 'operator'> } {
    return { role: 'operator' };
  }

  @RequireRole('conductor')
  @Post('conductor')
  @HttpCode(HttpStatus.OK)
  conductor(): { role: Extract<StaffRole, 'conductor'> } {
    return { role: 'conductor' };
  }
}
