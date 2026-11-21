import { describe, expect, it, vi } from 'vitest';
import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';

import { ServiceRefusalFilter } from './service-refusal.filter.js';

function hostFor(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };

  return {
    host: {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost,
    sent,
  };
}

function answerFor(exception: unknown): {
  status?: number;
  body?: Record<string, unknown>;
} {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const { host, sent } = hostFor();
  new ServiceRefusalFilter().catch(exception, host);
  return sent as { status?: number; body?: Record<string, unknown> };
}

describe('ServiceRefusalFilter', () => {
  it('answers a refusal with its code and refs, and no text', () => {
    const details = [
      {
        field: 'legs',
        rejectedValue: { availableCount: 2 },
        issueKey: 'ISSUE_NOT_ENOUGH_SEATS_ON_TRAIN',
        actionKey: 'ACTION_FEWER_PASSENGERS_OR_ANOTHER_CLASS',
      },
    ];

    const { status, body } = answerFor(
      new HttpException(
        { code: ErrorCode.INSUFFICIENT_SEATS, message: details },
        HttpStatus.CONFLICT,
      ),
    );

    expect(status).toBe(HttpStatus.CONFLICT);
    // The same shape the service would have sent over gRPC.
    expect(body).toEqual({
      code: ErrorCode.INSUFFICIENT_SEATS,
      details,
    });
    // No sentence in either language: only the edge knows the language.
    expect(JSON.stringify(body)).not.toMatch(/[A-Za-z]{4}\s[a-z]{3}\s/);
    expect(body).not.toHaveProperty('message');
  });

  it('keeps a retry hint when there is one', () => {
    const { body } = answerFor(
      new HttpException(
        { code: ErrorCode.DEPENDENCY_UNAVAILABLE, retryAfterSeconds: 5 },
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );

    expect(body).toEqual({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      details: [],
      retryAfterSeconds: 5,
    });
  });

  it('masks anything that is not an HttpException', () => {
    const { status, body } = answerFor(
      new Error('duplicate key value violates "seat_pkey"'),
    );

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toEqual({
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      details: [],
    });
    expect(JSON.stringify(body)).not.toContain('seat_pkey');
  });

  it('names a code for a Nest exception that carried none', () => {
    expect(answerFor(new HttpException('Not Found', 404)).body).toEqual({
      code: ErrorCode.ROUTE_NOT_FOUND,
      details: [],
    });
    expect(answerFor(new HttpException('Nope', 401)).body).toEqual({
      code: ErrorCode.UNAUTHORIZED,
      details: [],
    });
  });

  it('drops a detail that is not a validation ref', () => {
    const { body } = answerFor(
      new HttpException(
        { code: ErrorCode.VALIDATION_ERROR, message: ['a sentence', { x: 1 }] },
        HttpStatus.BAD_REQUEST,
      ),
    );

    expect(body).toEqual({ code: ErrorCode.VALIDATION_ERROR, details: [] });
  });

  it('leaves a non-HTTP context to the transport that owns it', () => {
    const rpc = {
      getType: () => 'rpc',
    } as unknown as ArgumentsHost;
    const boom = new Error('rpc');

    expect(() => new ServiceRefusalFilter().catch(boom, rpc)).toThrow(boom);
  });
});
