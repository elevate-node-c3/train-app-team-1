import { describe, expect, it } from 'vitest';
import { ErrorCode } from './error-codes.enum.js';
import { HTTP_STATUS_BY_ERROR_CODE } from './error-code-http.js';
import { GRPC_HTTP_MAP } from './grpc-status.js';

describe('ErrorCode HTTP mapping', () => {
  it('agrees with the gRPC mapping wherever both name the same code', () => {
    const grpcMappings = Object.values(GRPC_HTTP_MAP);
    let checked = 0;

    for (const [code, httpStatus] of Object.entries(
      HTTP_STATUS_BY_ERROR_CODE,
    )) {
      for (const mapping of grpcMappings) {
        if (mapping.errorCode !== code) continue;
        checked += 1;
        expect(
          httpStatus,
          `${code as ErrorCode} disagrees with GRPC_HTTP_MAP`,
        ).toBe(mapping.httpStatus);
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('maps passenger error codes to expected HTTP status codes', () => {
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PASSENGER_NOT_FOUND]).toBe(404);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PASSENGER_LIMIT_REACHED]).toBe(422);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.CANNOT_DELETE_SELF_PASSENGER]).toBe(422);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.NATIONAL_ID_LOCKED]).toBe(422);
  });
});
