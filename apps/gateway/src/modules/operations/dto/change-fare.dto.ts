import { IsISO8601, IsInt, IsString, IsUUID, Min } from 'class-validator';

/**
 * `POST /api/v1/operations/fares`.
 *
 * Shape only -- whether `effectiveFrom` is far enough in the future (BR-51) is
 * catalog's rule, checked again there regardless of what this validates.
 */
export class ChangeFareDto {
  @IsString()
  trainNumber!: string;

  @IsUUID()
  travelClassId!: string;

  @IsUUID()
  originStationId!: string;

  @IsUUID()
  destinationStationId!: string;

  @IsInt()
  @Min(0)
  amountPiastres!: number;

  /** ISO instant; "now or later" is catalog's rule, not this DTO's. */
  @IsISO8601()
  effectiveFrom!: string;
}
