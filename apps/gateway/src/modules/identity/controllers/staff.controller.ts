import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RequireRole } from '@app/common';
import type { StaffRole } from '@app/contracts';

/** Staff roles are separate capabilities, not ranks; travellers have neither. */
@Controller('auth/staff')
export class StaffController {
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
