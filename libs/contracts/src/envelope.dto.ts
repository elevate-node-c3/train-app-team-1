import { ErrorCode } from './error-codes.enum.js';

/** Display prose; ValidationIssueRef is the internal, language-free counterpart. */
export interface ValidationErrorDetail {
  field: string;
  rejectedValue: unknown;
  issue: string;
  action: string;
}

export function isValidationErrorDetail(
  value: unknown,
): value is ValidationErrorDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.field === 'string' &&
    typeof candidate.issue === 'string' &&
    typeof candidate.action === 'string'
  );
}

export interface ApiErrorDetail {
  code: ErrorCode | string;
  message: string;
  details?: ValidationErrorDetail[];
  /** Present on rate limits and retryable dependency failures. */
  retryAfterSeconds?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  message: string;
  error: ApiErrorDetail | null;
  correlationId: string;
  timestamp: string; // ISO-8601 UTC string
}
