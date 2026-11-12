import { IsIn, IsOptional } from 'class-validator';
import type { EventLanguage } from '@app/contracts';

/**
 * `GET /api/v1/trips/recent-searches`.
 *
 * Deliberately almost empty. There is no account parameter and there will not
 * be one: the traveller comes from the verified token, and a query parameter
 * naming an account would be an invitation to read somebody else's history.
 * Because the global pipe forbids non-whitelisted parameters, a client that
 * tries `?accountId=...` gets a 400 rather than being quietly ignored.
 */
export class RecentSearchesQueryDto {
  /**
   * The caller's declared preference. `Accept-Language` is what actually
   * decides the response language (BR-56); this travels on to catalog, which
   * returns both languages regardless.
   */
  @IsOptional()
  @IsIn(['ar', 'en'])
  language?: EventLanguage;
}
