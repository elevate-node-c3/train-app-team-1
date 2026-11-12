import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import {
  BadRequestException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ValidationPipe,
  type ArgumentsHost,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ErrorCode, type ApiResponse } from '@app/contracts';
import {
  resolveLanguage,
  resolveMessage,
  ResponseInterceptor,
  HttpExceptionFilter,
  CORRELATION_ID_KEY,
} from '@app/common';
import { MESSAGE_CATALOGUE } from './catalogue.js';
import { DETAIL_CATALOGUE } from './detail-catalogue.js';
import { parseCatalogBusinessError } from '../../../../apps/gateway/src/modules/catalog/catalog-error.js';
import { PublishTimetableStopDto } from '../../../../apps/gateway/src/modules/operations/dto/publish-timetable.dto.js';
import { validationExceptionFactory } from './validation-exception.factory.js';

describe('Envelope & i18n Translation System (BR-56, BR-57, D14, §2.4)', () => {
  const clsMock = {
    get: (key: string) =>
      key === CORRELATION_ID_KEY ? 'test-corr-id-123' : undefined,
  } as unknown as ClsService;

  describe('Language Resolver & Message Catalogue (BR-56, D14)', () => {
    it('selects Arabic by default when Accept-Language is missing', () => {
      expect(resolveLanguage(undefined)).toBe('ar');
    });

    it('selects Arabic when Accept-Language is unsupported (fallback to Arabic)', () => {
      expect(resolveLanguage('fr-FR')).toBe('ar');
      expect(resolveLanguage('de')).toBe('ar');
      expect(resolveLanguage('zh-CN')).toBe('ar');
    });

    it('selects English when Accept-Language contains en, en-GB, en-US', () => {
      expect(resolveLanguage('en')).toBe('en');
      expect(resolveLanguage('en-GB')).toBe('en');
      expect(resolveLanguage('en-US,en;q=0.9')).toBe('en');
    });

    it('returns Arabic messages by default', () => {
      const msg = resolveMessage(ErrorCode.SUCCESS, 'ar');
      expect(msg).toBe('تمت العملية بنجاح');

      const notFoundMsg = resolveMessage(ErrorCode.ROUTE_NOT_FOUND, 'ar');
      expect(notFoundMsg).toBe('المسار المطلوب غير موجود');
    });

    it('returns English messages when en is selected', () => {
      const msg = resolveMessage(ErrorCode.SUCCESS, 'en');
      expect(msg).toBe('Operation completed successfully');

      const notFoundMsg = resolveMessage(ErrorCode.ROUTE_NOT_FOUND, 'en');
      expect(notFoundMsg).toBe('The requested route was not found');
    });
  });

  describe('ResponseInterceptor', () => {
    const interceptor = new ResponseInterceptor(clsMock);

    it('wraps successful data in the unified envelope with correlationId and timestamp', async () => {
      const mockExecutionContext = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': 'ar' },
          }),
        }),
      } as unknown as ExecutionContext;

      const callHandler = {
        handle: () => of({ testKey: 'testValue' }),
      };

      const result$ = interceptor.intercept(mockExecutionContext, callHandler);
      const res = await new Promise<any>((resolve) =>
        result$.subscribe(resolve),
      );

      expect(res.success).toBe(true);
      expect(res.data).toEqual({ testKey: 'testValue' });
      expect(res.message).toBe('تمت العملية بنجاح');
      expect(res.error).toBeNull();
      expect(res.correlationId).toBe('test-corr-id-123');
      expect(typeof res.timestamp).toBe('string');
      expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp);
    });

    it('uses English message when Accept-Language is en-US', async () => {
      const mockExecutionContext = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': 'en-US' },
          }),
        }),
      } as unknown as ExecutionContext;

      const callHandler = {
        handle: () => of({ ok: true }),
      };

      const result$ = interceptor.intercept(mockExecutionContext, callHandler);
      const res = await new Promise<any>((resolve) =>
        result$.subscribe(resolve),
      );

      expect(res.success).toBe(true);
      expect(res.message).toBe('Operation completed successfully');
      expect(res.error).toBeNull();
    });
  });

  describe('HttpExceptionFilter (BR-57 & §2.4)', () => {
    const filter = new HttpExceptionFilter(clsMock);

    beforeEach(() => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function renderError(exception: unknown, acceptLanguage?: string) {
      let responseBody!: ApiResponse<null>;
      const host = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': acceptLanguage },
          }),
          getResponse: () => ({
            status: () => ({
              json: (body: ApiResponse<null>) => {
                responseBody = body;
              },
            }),
          }),
        }),
      } as unknown as ArgumentsHost;
      filter.catch(exception, host);
      return responseBody;
    }

    function renderDetails(message: unknown, acceptLanguage?: string) {
      return renderError(new BadRequestException({ message }), acceptLanguage);
    }

    it.each(['ar', 'en'] as const)(
      'explains the valid clock range for correctly shaped invalid times in %s',
      async (language) => {
        const pipe = new ValidationPipe({
          exceptionFactory: validationExceptionFactory,
        });
        for (const time of ['24:00', '12:60']) {
          const exception = await pipe
            .transform(
              {
                stationId: '11111111-1111-4111-8111-111111111111',
                position: 1,
                arrivalTime: time,
                departureTime: time,
                dayOffset: 0,
              },
              { type: 'body', metatype: PublishTimetableStopDto },
            )
            .catch((error: unknown) => error);
          expect(exception).toBeInstanceOf(BadRequestException);
          const body = renderError(exception, language);
          const issue =
            language === 'en'
              ? 'This time must be a valid time of day from 00:00 to 23:59, written as HH:mm.'
              : 'هذا الوقت يجب أن يكون صالحاً من 00:00 إلى 23:59، على صورة HH:mm.';
          expect(body.error?.details).toEqual([
            {
              field: 'arrivalTime',
              rejectedValue: time,
              issue,
              action: DETAIL_CATALOGUE.ACTION_DEFAULT[language],
            },
            {
              field: 'departureTime',
              rejectedValue: time,
              issue,
              action: DETAIL_CATALOGUE.ACTION_DEFAULT[language],
            },
          ]);
        }
      },
    );

    it('resolves issueKey and actionKey into the request language', () => {
      const body = renderDetails(
        [
          {
            field: 'amountPiastres',
            rejectedValue: 1,
            issueKey: 'ISSUE_MUST_BE_UUID',
            actionKey: 'ACTION_DEFAULT',
          },
        ],
        'en',
      );
      expect(body.error?.details?.[0]).toEqual({
        field: 'amountPiastres',
        rejectedValue: 1,
        issue: 'This value must be a valid identifier.',
        action: "Send a value that meets this field's constraints.",
      });
    });

    it('uses the localized default action when actionKey is absent', () => {
      const body = renderDetails(
        [{ field: 'id', rejectedValue: 'bad', issueKey: 'ISSUE_MUST_BE_UUID' }],
        'ar',
      );
      expect(body.error?.details?.[0].action).toBe(
        DETAIL_CATALOGUE.ACTION_DEFAULT.ar,
      );
    });

    it('falls back to the generic issue for an unknown issueKey', () => {
      const body = renderDetails(
        [
          {
            field: 'id',
            rejectedValue: 'bad',
            issueKey: 'ISSUE_NEW_SERVICE_VERSION',
          },
        ],
        'en',
      );
      expect(body.error?.details?.[0].issue).toBe(
        DETAIL_CATALOGUE.ISSUE_VALIDATION_FAILED.en,
      );
      expect(JSON.stringify(body)).not.toContain('ISSUE_');
    });

    it.each([undefined, '*', 'fr-FR', 'ar-EG,en;q=0.9'])(
      'resolves details and headline to Arabic for %s',
      (header) => {
        const body = renderDetails(
          [{ field: 'id', rejectedValue: null, issueKey: 'ISSUE_REQUIRED' }],
          header,
        );
        expect(body.error?.details?.[0].issue).toBe(
          DETAIL_CATALOGUE.ISSUE_REQUIRED.ar,
        );
        expect(body.message).toBe(MESSAGE_CATALOGUE.VALIDATION_ERROR.ar);
      },
    );

    it('resolves template params without exposing refs or internal objects', () => {
      const body = renderDetails(
        [
          {
            field: 'returnDate',
            rejectedValue: '2026-11-30',
            issueKey: 'ISSUE_REQUIRED',
            actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
            params: { departureDate: '2026-12-01' },
            target: { internalSecret: 'do-not-echo' },
          },
        ],
        'en-US,en;q=0.9',
      );
      expect(body.error?.details?.[0].action).toBe(
        'Pick a return date on or after 2026-12-01.',
      );
      expect(JSON.stringify(body)).not.toMatch(
        /issueKey|actionKey|params|internalSecret|\{\{/,
      );
    });

    it('echoes a non-primitive rejectedValue and Arabic-Indic digits verbatim', () => {
      const rejectedValue = { nested: ['٠٦:٠٠'] };
      const body = renderDetails(
        [{ field: 'time', rejectedValue, issueKey: 'ISSUE_WRONG_FORMAT' }],
        'ar',
      );
      expect(() => JSON.stringify(body)).not.toThrow();
      expect(body.error?.details?.[0].rejectedValue).toEqual(rejectedValue);
    });

    it('uses the default action for an unknown actionKey', () => {
      const body = renderDetails(
        [
          {
            field: 'id',
            issueKey: 'ISSUE_REQUIRED',
            actionKey: 'ACTION_NEW_SERVICE_VERSION',
          },
        ],
        'en',
      );
      expect(body.error?.details?.[0].action).toBe(
        DETAIL_CATALOGUE.ACTION_DEFAULT.en,
      );
    });

    it('does not expose an unresolved template to the caller', () => {
      const body = renderDetails(
        [
          {
            field: 'returnDate',
            issueKey: 'ISSUE_REQUIRED',
            actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
          },
        ],
        'en',
      );
      expect(body.error?.details?.[0].action).toBe(
        DETAIL_CATALOGUE.ACTION_DEFAULT.en,
      );
      expect(JSON.stringify(body)).not.toContain('{{');
    });

    it('drops a detail carrying literal prose instead of a key', () => {
      const body = renderDetails(
        [{ field: 'to', issue: 'legacy prose', action: 'legacy action' }],
        'en',
      );
      expect(body.error?.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/legacy prose|legacy action/);
    });

    it('drops legacy constraints, object messages, and malformed detail objects', () => {
      const body = renderDetails(
        [
          {
            property: 'id',
            constraints: { isUuid: 'private English constraint' },
          },
          { field: 'id', message: 'private object message' },
          { property: 'id', issueKey: 'ISSUE_REQUIRED' },
          { field: 'id', issueKey: 42 },
          null,
          42,
          false,
        ],
        'ar',
      );
      expect(body.error?.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(
        /private English|private object/,
      );
    });

    it('drops legacy objects from mixed arrays without dropping usable refs or bare strings', () => {
      const body = renderDetails(
        [
          { field: 'id', issue: 'legacy prose' },
          { field: 'to', issueKey: 'ISSUE_REQUIRED', rejectedValue: null },
          'email must be an email',
        ],
        'en',
      );
      expect(body.error?.details?.map((detail) => detail.field)).toEqual([
        'to',
        'email',
      ]);
      expect(JSON.stringify(body.error?.details)).not.toContain('legacy prose');
    });

    it('preserves the canonical field and rejectedValue rather than internal metadata', () => {
      const body = renderDetails(
        [
          {
            field: 'to',
            property: 'internal-property',
            rejectedValue: { nested: ['٠٦:٠٠'] },
            value: 'internal-value',
            issueKey: 'ISSUE_REQUIRED',
          },
        ],
        'en',
      );
      expect(body.error?.details?.[0]).toEqual({
        field: 'to',
        rejectedValue: { nested: ['٠٦:٠٠'] },
        issue: DETAIL_CATALOGUE.ISSUE_REQUIRED.en,
        action: DETAIL_CATALOGUE.ACTION_DEFAULT.en,
      });
    });

    it('still maps a bare class-validator string array and a single Nest string', () => {
      const array = renderDetails(['email must be an email'], 'ar');
      expect(array.error?.details).toHaveLength(1);
      expect(array.error?.details?.[0].field).toBe('email');
      const single = renderDetails('A Nest validation message', 'en');
      expect(single.error?.details?.[0]).toEqual({
        field: 'payload',
        rejectedValue: undefined,
        issue: 'A Nest validation message',
        action: DETAIL_CATALOGUE.ACTION_DEFAULT.en,
      });
    });

    it.each([
      null,
      [],
      'invalid',
      { containedFarePiastres: 42 },
      { containedFarePiastres: null },
    ])(
      'never exposes a missing issue placeholder for malformed params %j',
      (params) => {
        const body = renderDetails(
          [
            {
              field: 'amountPiastres',
              rejectedValue: 5000,
              issueKey: 'ISSUE_FARE_BELOW_CONTAINED_SEGMENT',
              actionKey: 'ACTION_RAISE_FARE_TO_CONTAINED_SEGMENT',
              params,
            },
          ],
          'en',
        );
        expect(body.error?.details?.[0].issue).toBe(
          DETAIL_CATALOGUE.ISSUE_VALIDATION_FAILED.en,
        );
        expect(body.error?.details?.[0].action).toBe(
          DETAIL_CATALOGUE.ACTION_DEFAULT.en,
        );
        expect(JSON.stringify(body)).not.toMatch(/\{\{|undefined/);
      },
    );

    it.each(['ar', 'en'] as const)(
      'renders decoded 404 refs in %s without changing the code or headline',
      (language) => {
        const exception = parseCatalogBusinessError({
          details: JSON.stringify({
            code: ErrorCode.RESOURCE_NOT_FOUND,
            details: [
              {
                field: 'outboundTripId',
                rejectedValue: 'missing-trip',
                issueKey: 'ISSUE_OUTBOUND_TRIP_GONE',
                actionKey: 'ACTION_SEARCH_AGAIN_FOR_OUTBOUND',
              },
            ],
          }),
        });
        expect(exception?.getStatus()).toBe(HttpStatus.NOT_FOUND);
        const body = renderError(exception, language);
        expect(body.error?.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
        expect(body.message).toBe(
          MESSAGE_CATALOGUE.RESOURCE_NOT_FOUND[language],
        );
        expect(body.error?.details?.[0]).toEqual({
          field: 'outboundTripId',
          rejectedValue: 'missing-trip',
          issue: DETAIL_CATALOGUE.ISSUE_OUTBOUND_TRIP_GONE[language],
          action: DETAIL_CATALOGUE.ACTION_SEARCH_AGAIN_FOR_OUTBOUND[language],
        });
      },
    );

    it.each(['ar', 'en'] as const)(
      'renders decoded 409 counts and corrective dates in %s',
      (language) => {
        const exception = parseCatalogBusinessError({
          details: JSON.stringify({
            code: ErrorCode.CONFLICT,
            details: [
              {
                field: 'stops',
                rejectedValue: '2026-12-01',
                issueKey: 'ISSUE_PUBLISH_WOULD_CHANGE_IN_USE_TRIP',
                actionKey: 'ACTION_PUBLISH_AFTER_IN_USE_TRIPS',
                params: {
                  tripId: 'trip-1',
                  serviceDate: '2026-12-01',
                  soldCount: '2',
                  heldCount: '1',
                  laterDate: '2027-01-01',
                },
              },
            ],
          }),
        });
        expect(exception?.getStatus()).toBe(HttpStatus.CONFLICT);
        const body = renderError(exception, language);
        expect(body.error?.code).toBe(ErrorCode.CONFLICT);
        expect(body.message).toBe(MESSAGE_CATALOGUE.CONFLICT[language]);
        const detail = body.error?.details?.[0];
        expect(detail?.issue).toBe(
          language === 'en'
            ? "For trip trip-1 on 2026-12-01, sold seats total 2 and held seats total 1. This publish would change the trip's stops or times."
            : 'في الرحلة trip-1 بتاريخ 2026-12-01، يبلغ عدد المقاعد المباعة 2 وعدد المقاعد المحجوزة مؤقتاً 1. نشر هذا الجدول سيغيّر محطات الرحلة أو أوقاتها.',
        );
        expect(detail?.action).toContain('2027-01-01');
        expect(JSON.stringify(detail)).not.toMatch(
          /issueKey|actionKey|params|\{\{|undefined/,
        );
      },
    );

    it.each(['ar', 'en'] as const)(
      'renders retryable decoded 503 instructions in %s, preserving retry seconds',
      (language) => {
        const exception = parseCatalogBusinessError({
          details: JSON.stringify({
            code: ErrorCode.DEPENDENCY_UNAVAILABLE,
            retryAfterSeconds: 5,
            details: [
              {
                field: 'trainNumber',
                rejectedValue: '900',
                issueKey: 'ISSUE_SEAT_USAGE_UNAVAILABLE',
                actionKey: 'ACTION_RETRY_PUBLISH',
                params: { retryAfterSeconds: '5' },
              },
            ],
          }),
        });
        expect(exception?.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = renderError(exception, language);
        expect(body.error?.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
        expect(body.error?.retryAfterSeconds).toBe(5);
        expect(body.message).toBe(
          MESSAGE_CATALOGUE.DEPENDENCY_UNAVAILABLE[language],
        );
        expect(body.error?.details?.[0]).toEqual({
          field: 'trainNumber',
          rejectedValue: '900',
          issue: DETAIL_CATALOGUE.ISSUE_SEAT_USAGE_UNAVAILABLE[language],
          action:
            language === 'en'
              ? 'Retry the publish with the same idempotency key in about 5 seconds.'
              : 'أعد محاولة نشر الجدول الزمني بمفتاح المعاملة نفسه بعد نحو 5 ثانية.',
        });
      },
    );

    it.each([
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.SERVICE_UNAVAILABLE,
    ])('never treats raw strings as detail refs for HTTP %s', (status) => {
      const body = renderError(
        new HttpException(
          {
            message: ['private upstream string'],
            code:
              status === HttpStatus.SERVICE_UNAVAILABLE
                ? ErrorCode.DEPENDENCY_UNAVAILABLE
                : ErrorCode.CONFLICT,
          },
          status,
        ),
        'en',
      );
      expect(body.error?.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('private upstream string');
    });

    it('does not expose refs, rejected data or legacy prose from ordinary HTTP 500 errors', () => {
      const body = renderError(
        new HttpException(
          {
            message: [
              {
                field: 'query',
                rejectedValue: 'SELECT private secret',
                issueKey: 'ISSUE_REQUIRED',
                actionKey: 'ACTION_DEFAULT',
              },
            ],
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
        'en',
      );
      expect(body.error?.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/SELECT|secret|issueKey/);
    });

    it('formats validation errors with field, rejectedValue, issue, and action (BR-57)', () => {
      let responseStatus = 0;
      let responseBody: any = null;

      const mockRes = {
        status: (s: number) => {
          responseStatus = s;
          return {
            json: (b: any) => {
              responseBody = b;
            },
          };
        },
      };

      const mockHost = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': 'ar' },
          }),
          getResponse: () => mockRes,
        }),
      } as unknown as any;

      const validationException = new BadRequestException([
        'email must be an email',
        'password must be longer than 8 characters',
      ]);

      filter.catch(validationException, mockHost);

      expect(responseStatus).toBe(400);
      expect(responseBody.success).toBe(false);
      expect(responseBody.data).toBeNull();
      expect(responseBody.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(responseBody.error.details).toBeDefined();
      expect(responseBody.error.details.length).toBe(2);

      const firstDetail = responseBody.error.details[0];
      expect(firstDetail.field).toBe('email');
      expect(firstDetail.issue).toContain('email must be an email');
      expect(firstDetail.action).toBeDefined();
      expect(firstDetail.action.length).toBeGreaterThan(5);
    });

    it('suppresses internal SQL errors, stack traces, and details (§2.4)', () => {
      let responseStatus = 0;
      let responseBody: any = null;

      const mockRes = {
        status: (s: number) => {
          responseStatus = s;
          return {
            json: (b: any) => {
              responseBody = b;
            },
          };
        },
      };

      const mockHost = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': 'en' },
          }),
          getResponse: () => mockRes,
        }),
      } as unknown as any;

      // Sensitive internal DB error
      const rawSqlError = new Error(
        'syntax error at or near "SELECT * FROM users WHERE password = secret"',
      );

      filter.catch(rawSqlError, mockHost);

      expect(responseStatus).toBe(500);
      expect(responseBody.success).toBe(false);
      expect(responseBody.data).toBeNull();
      expect(responseBody.error.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
      // Ensure raw SQL and password are NOT in the client envelope
      expect(responseBody.error.message).toBe(
        'An unexpected internal server error occurred, please try again later',
      );
      expect(JSON.stringify(responseBody)).not.toContain('SELECT * FROM');
      expect(JSON.stringify(responseBody)).not.toContain('secret');
      expect(responseBody.correlationId).toBe('test-corr-id-123');
    });

    it('formats 404 Route Not Found into standard envelope', () => {
      let responseStatus = 0;
      let responseBody: any = null;

      const mockRes = {
        status: (s: number) => {
          responseStatus = s;
          return {
            json: (b: any) => {
              responseBody = b;
            },
          };
        },
      };

      const mockHost = {
        getType: () => 'http',
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'accept-language': 'ar' },
          }),
          getResponse: () => mockRes,
        }),
      } as unknown as any;

      const notFound = new NotFoundException('Cannot GET /api/unknown');
      filter.catch(notFound, mockHost);

      expect(responseStatus).toBe(404);
      expect(responseBody.success).toBe(false);
      expect(responseBody.error.code).toBe(ErrorCode.ROUTE_NOT_FOUND);
      expect(responseBody.error.message).toBe('المسار المطلوب غير موجود');
    });
  });
});
