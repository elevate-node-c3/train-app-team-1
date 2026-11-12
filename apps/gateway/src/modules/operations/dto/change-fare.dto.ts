import { IsISO8601, IsInt, IsString, IsUUID, Min } from 'class-validator';

/** Shape only; whether `effectiveFrom` is future enough (BR-51) is catalog's rule. */
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

  /** ISO instant; "now or later" is catalog's rule. */
  @IsISO8601()
  effectiveFrom!: string;
}
