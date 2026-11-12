import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import {
  BadRequestException,
  ExecutionContext,
  Logger,
  NotFoundException,
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

    function renderDetails(message: unknown, acceptLanguage?: string) {
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
      filter.catch(new BadRequestException({ message }), host);
      return responseBody;
    }

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

    it('still accepts a literal issue string during migration', () => {
      const body = renderDetails(
        [{ field: 'to', issue: 'legacy prose', action: 'legacy action' }],
        'en',
      );
      expect(body.error?.details?.[0].issue).toBe('legacy prose');
      expect(body.error?.details?.[0].action).toBe('legacy action');
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
