import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';

import {
  ErrorCode,
  GRPC_STATUS,
  GRPC_STATUS_BY_ERROR_CODE,
  HTTP_STATUS_BY_ERROR_CODE,
  grpcStatusForErrorCode,
} from '@app/contracts';
import { MESSAGE } from '@app/common/envelope/messages.js';
import {
  decodeRefusal,
  isRefusalError,
  refusalException,
  toRpcException,
} from '@app/common';

/**
 * Every service answers a failure the same way: a code from the enum, field
 * refs as catalogue keys, no prose, and one mapping to a status. The text a
 * caller reads is resolved at the edge, in Arabic or English, from their
 * Accept-Language -- so a service that writes a sentence here would answer
 * every caller in one language.
 */

const ROOT = process.cwd();

/** Where the shared implementation lives, and the only place exempt. */
const SHARED_ERRORS_DIR = join('libs', 'common', 'src', 'errors');

/** SUCCESS and ALL_SERVICES_READY describe an answer, not a failure. */
const NON_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.SUCCESS,
  ErrorCode.ALL_SERVICES_READY,
]);

function failureCodes(): ErrorCode[] {
  return Object.values(ErrorCode).filter(
    (code) => !NON_FAILURE_CODES.has(code),
  );
}

function sourceFilesIn(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      found = found.concat(sourceFilesIn(rel));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.int-spec.ts')
    ) {
      found.push(rel);
    }
  }
  return found;
}

function productionSources(): { path: string; text: string }[] {
  return [...sourceFilesIn('apps'), ...sourceFilesIn('libs')].map((path) => ({
    path,
    text: readFileSync(join(ROOT, path), 'utf8'),
  }));
}

function isSharedErrorModule(path: string): boolean {
  return path.startsWith(SHARED_ERRORS_DIR + sep);
}

/** gRPC statuses that blame the caller, and the ones that blame us. */
const CALLER_STATUSES: ReadonlySet<number> = new Set([
  GRPC_STATUS.INVALID_ARGUMENT,
  GRPC_STATUS.NOT_FOUND,
  GRPC_STATUS.ALREADY_EXISTS,
  GRPC_STATUS.PERMISSION_DENIED,
  GRPC_STATUS.RESOURCE_EXHAUSTED,
  GRPC_STATUS.FAILED_PRECONDITION,
  GRPC_STATUS.ABORTED,
  GRPC_STATUS.OUT_OF_RANGE,
  GRPC_STATUS.UNAUTHENTICATED,
]);

function envelopeOf(exception: RpcException): {
  code: ErrorCode;
  details?: unknown[];
  retryAfterSeconds?: number;
} {
  const payload = exception.getError() as { details: string };
  return JSON.parse(payload.details);
}

function statusOf(exception: RpcException): number {
  return (exception.getError() as { code: number }).code;
}

describe('Unified error handling', () => {
  it('finds production sources to check', () => {
    expect(productionSources().length).toBeGreaterThan(100);
  });

  describe('one implementation', () => {
    it('builds an RpcException in exactly one place', () => {
      const offenders = productionSources()
        .filter(
          ({ path, text }) =>
            text.includes('new RpcException(') && !isSharedErrorModule(path),
        )
        .map(({ path }) => path);

      expect(
        offenders,
        'Throw a refusal class and let toRpcException build the envelope',
      ).toEqual([]);
    });

    it('keeps the ErrorCode to gRPC status table out of the services', () => {
      const offenders = productionSources()
        .filter(({ path }) => path.startsWith('apps' + sep))
        .filter(
          ({ text }) =>
            // The shape of a second mapping table forming inside a service.
            /Record<\s*ErrorCode\s*,/.test(text) &&
            /(grpc\.status\.|GRPC_STATUS\.|status\.[A-Z_]+)/.test(text),
        )
        .map(({ path }) => path);

      expect(
        offenders,
        'Add the mapping to libs/contracts/src/error-code-grpc.ts instead',
      ).toEqual([]);
    });

    it('lets no gRPC controller leak an error it did not decide', () => {
      const offenders = productionSources()
        .filter(({ path }) => path.endsWith('.grpc.controller.ts'))
        .filter(({ text }) => {
          const usesBoundary =
            text.includes('toRpcException') ||
            text.includes('refusalException');
          // A controller that answers its own failures may keep doing so;
          // anything that throws, or that catches nothing at all, must not.
          const answersItself =
            text.includes('catch') && !text.includes('throw');
          return !usesBoundary && !answersItself;
        })
        .map(({ path }) => path);

      // An unhandled handler puts a driver error's own message on the wire.
      expect(offenders).toEqual([]);
    });
  });

  describe('the tables are complete', () => {
    it('gives every failure code a gRPC status', () => {
      const missing = failureCodes().filter(
        (code) => GRPC_STATUS_BY_ERROR_CODE[code] === undefined,
      );

      expect(missing).toEqual([]);
    });

    it('gives every failure code an HTTP status', () => {
      const missing = failureCodes().filter(
        (code) => HTTP_STATUS_BY_ERROR_CODE[code] === undefined,
      );

      expect(missing).toEqual([]);
    });

    it('agrees with itself about who is at fault', () => {
      const disagreements = failureCodes()
        .map((code) => ({
          code,
          http: HTTP_STATUS_BY_ERROR_CODE[code] ?? 0,
          grpc: GRPC_STATUS_BY_ERROR_CODE[code] ?? GRPC_STATUS.INTERNAL,
        }))
        .filter(({ http, grpc }) => http < 500 !== CALLER_STATUSES.has(grpc))
        .map(
          ({ code, http, grpc }) =>
            `${code}: HTTP ${http} with gRPC status ${grpc}`,
        );

      expect(disagreements).toEqual([]);
    });
  });

  describe('both languages, resolved at the edge', () => {
    it('has an Arabic and an English message for every code', () => {
      const broken = Object.values(ErrorCode).filter((code) => {
        const entry = MESSAGE[code];
        return (
          !entry ||
          typeof entry.ar !== 'string' ||
          typeof entry.en !== 'string' ||
          entry.ar.trim().length === 0 ||
          entry.en.trim().length === 0
        );
      });

      expect(broken).toEqual([]);
    });

    it('does not pass an English message off as the Arabic one', () => {
      const untranslated = Object.values(ErrorCode).filter(
        (code) => MESSAGE[code]?.ar === MESSAGE[code]?.en,
      );

      expect(untranslated).toEqual([]);
    });

    it('leaves no placeholder unfilled in either language', () => {
      const unfilled = Object.values(ErrorCode).filter((code) => {
        const entry = MESSAGE[code];
        // A message is resolved without params, so it cannot carry any.
        return entry?.ar.includes('{{') || entry?.en.includes('{{');
      });

      expect(unfilled).toEqual([]);
    });

    it('puts no prose on the wire, only the code and its keys', () => {
      const exception = refusalException({
        code: ErrorCode.INSUFFICIENT_SEATS,
        details: [
          {
            field: 'legs',
            rejectedValue: { availableCount: 2 },
            issueKey: 'ISSUE_NOT_ENOUGH_SEATS_ON_TRAIN',
            actionKey: 'ACTION_FEWER_PASSENGERS_OR_ANOTHER_CLASS',
          },
        ],
      });

      const payload = exception.getError() as {
        message: string;
        code: number;
      };
      // The code is the message: the edge resolves the language.
      expect(payload.message).toBe(ErrorCode.INSUFFICIENT_SEATS);
      expect(Object.keys(envelopeOf(exception)).sort()).toEqual([
        'code',
        'details',
      ]);
    });
  });

  describe('every service refuses the same way', () => {
    it('maps each failure code to its one status', () => {
      for (const code of failureCodes()) {
        const exception = refusalException({ code, details: [] });

        expect(statusOf(exception)).toBe(GRPC_STATUS_BY_ERROR_CODE[code]);
        expect(envelopeOf(exception).code).toBe(code);
      }
    });

    it('round-trips every failure code back out of the envelope', () => {
      for (const code of failureCodes()) {
        const exception = refusalException({ code, details: [] });

        expect(decodeRefusal(exception)?.code).toBe(code);
      }
    });

    it('masks anything a service did not decide', () => {
      const driverError = Object.assign(
        new Error('duplicate key value violates unique constraint "seat_pkey"'),
        { detail: 'Key (national_id)=(29001011234567) already exists.' },
      );

      const exception = toRpcException(driverError);

      expect(statusOf(exception)).toBe(GRPC_STATUS.INTERNAL);
      expect(envelopeOf(exception).code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
      const wire = JSON.stringify(exception.getError());
      expect(wire).not.toContain('seat_pkey');
      expect(wire).not.toContain('29001011234567');
    });

    it('does not mistake a database or filesystem code for a refusal', () => {
      // Postgres says '23505' and Node says 'ENOENT'; neither is a decision.
      for (const code of ['23505', 'ENOENT', 'ECONNREFUSED']) {
        expect(isRefusalError(Object.assign(new Error('boom'), { code }))).toBe(
          false,
        );
      }

      expect(
        isRefusalError(
          Object.assign(new Error('boom'), { code: ErrorCode.SALES_CLOSED }),
        ),
      ).toBe(true);
    });

    it('leaves an already-built refusal alone', () => {
      const exception = refusalException({
        code: ErrorCode.TERMS_REQUIRED,
        details: [],
      });

      expect(toRpcException(exception)).toBe(exception);
    });

    it('carries a retry hint only when there is one', () => {
      const withHint = refusalException({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        details: [],
        retryAfterSeconds: 5,
      });
      const without = refusalException({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        details: [],
      });

      expect(envelopeOf(withHint).retryAfterSeconds).toBe(5);
      expect(envelopeOf(without).retryAfterSeconds).toBeUndefined();
      expect(decodeRefusal(withHint)?.retryAfterSeconds).toBe(5);
    });

    it('drops a detail that did not arrive in the agreed shape', () => {
      const exception = new RpcException({
        code: grpcStatusForErrorCode(ErrorCode.VALIDATION_ERROR),
        message: ErrorCode.VALIDATION_ERROR,
        details: JSON.stringify({
          code: ErrorCode.VALIDATION_ERROR,
          details: [{ nonsense: true }, 'a sentence'],
        }),
      });

      expect(decodeRefusal(exception)?.details).toEqual([]);
    });

    it('reports no refusal when a code is not one of ours', () => {
      expect(
        decodeRefusal(JSON.stringify({ code: 'SOMETHING_ELSE' })),
      ).toBeNull();
      expect(decodeRefusal('not json')).toBeNull();
      expect(decodeRefusal(undefined)).toBeNull();
    });
  });
});
