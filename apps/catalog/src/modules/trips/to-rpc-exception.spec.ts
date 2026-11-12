import * as grpc from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@app/contracts';

import { CatalogSearchError } from './catalog-search-error.js';
import { toRpcException } from './to-rpc-exception.js';

function detailOf(exception: unknown) {
  const payload = (exception as RpcException).getError() as { details: string };
  return JSON.parse(payload.details) as {
    code: string;
    details: unknown[];
    retryAfterSeconds?: number;
  };
}

describe('toRpcException', () => {
  it('leaves a non-CatalogSearchError alone', () => {
    const boom = new Error('connection reset');

    expect(toRpcException(boom)).toBe(boom);
  });

  it('maps VALIDATION_ERROR to INVALID_ARGUMENT', () => {
    const error = new CatalogSearchError(ErrorCode.VALIDATION_ERROR, []);

    const exception = toRpcException(error) as RpcException;

    expect(exception).toBeInstanceOf(RpcException);
    expect((exception.getError() as { code: number }).code).toBe(
      grpc.status.INVALID_ARGUMENT,
    );
    expect(detailOf(exception).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps RESOURCE_NOT_FOUND to NOT_FOUND', () => {
    const error = new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, []);

    const exception = toRpcException(error) as RpcException;

    expect((exception.getError() as { code: number }).code).toBe(
      grpc.status.NOT_FOUND,
    );
  });

  it('maps CONFLICT to ABORTED', () => {
    const error = new CatalogSearchError(ErrorCode.CONFLICT, []);

    const exception = toRpcException(error) as RpcException;

    expect((exception.getError() as { code: number }).code).toBe(
      grpc.status.ABORTED,
    );
  });

  // The CARRY item from Task 8/9: `CatalogSearchError` has no field for the
  // wait, so this is the one place left to put it into the envelope.
  it('maps DEPENDENCY_UNAVAILABLE to UNAVAILABLE and sets retryAfterSeconds', () => {
    const error = new CatalogSearchError(ErrorCode.DEPENDENCY_UNAVAILABLE, [
      {
        field: 'trainNumber',
        rejectedValue: '101',
        issueKey: 'ISSUE_SEAT_USAGE_UNAVAILABLE',
        actionKey: 'ACTION_RETRY_PUBLISH',
        params: { retryAfterSeconds: '5' },
      },
    ]);

    const exception = toRpcException(error) as RpcException;

    expect((exception.getError() as { code: number }).code).toBe(
      grpc.status.UNAVAILABLE,
    );
    const decoded = detailOf(exception);
    expect(decoded.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(decoded.retryAfterSeconds).toBe(5);
    expect(decoded.details).toEqual(error.details);
  });

  it('does not set retryAfterSeconds for a code that is not retryable', () => {
    const error = new CatalogSearchError(ErrorCode.VALIDATION_ERROR, []);

    const decoded = detailOf(toRpcException(error));

    expect(decoded.retryAfterSeconds).toBeUndefined();
  });
});
