import { IsIn, IsOptional } from 'class-validator';
import type { EventLanguage } from '@app/contracts';

/** Account comes from the verified token; query account IDs are rejected. */
export class RecentSearchesQueryDto {
  /** Optional preference; catalog still returns both languages. */
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
