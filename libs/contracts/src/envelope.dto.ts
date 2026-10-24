import { ErrorCode } from './error-codes.enum.js';

export interface ValidationErrorDetail {
  field: string;
  rejectedValue: unknown;
  issue: string;
  action: string;
}

export interface ApiErrorDetail {
  code: ErrorCode | string;
  message: string;
  details?: ValidationErrorDetail[];
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  message: string;
  error: ApiErrorDetail | null;
  correlationId: string;
  timestamp: string; // ISO-8601 UTC string
}
