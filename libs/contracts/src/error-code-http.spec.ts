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
});
