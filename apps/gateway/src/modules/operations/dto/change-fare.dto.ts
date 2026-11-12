import { IsISO8601, IsInt, IsString, IsUUID, Min } from 'class-validator';

/** Catalog checks effectiveFrom; the gateway checks only the request shape. */
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

  /** ISO timestamp; catalog requires now or later. */
  @IsISO8601()
  effectiveFrom!: string;
}
