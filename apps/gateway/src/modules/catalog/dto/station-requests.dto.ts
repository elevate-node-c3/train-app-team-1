import type { CreateStationRequest } from '@app/contracts';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

function trimText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function trimAliases(value: unknown): unknown {
  return Array.isArray(value) ? value.map(trimText) : value;
}

export class StationIdParamDto {
  @IsUUID()
  declare id: string;
}

export class CreateStationDto implements CreateStationRequest {
  @IsUUID()
  declare cityId: string;

  @Transform(({ value }) => trimText(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare nameAr: string;

  @Transform(({ value }) => trimText(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare nameEn: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => trimAliases(value))
  @IsArray()
  @ArrayMaxSize(100, { context: { issueKey: 'ISSUE_ABOVE_MAXIMUM' } })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(120, { each: true })
  declare altSpellings?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  declare isActive?: boolean;
}

export class UpdateStationDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  declare cityId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => trimText(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare nameAr?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => trimText(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare nameEn?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => trimAliases(value))
  @IsArray()
  @ArrayMaxSize(100, { context: { issueKey: 'ISSUE_ABOVE_MAXIMUM' } })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(120, { each: true })
  declare altSpellings?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  declare isActive?: boolean;
}
