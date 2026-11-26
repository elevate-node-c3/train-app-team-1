import { StreamableFile, type ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { ClsService } from 'nestjs-cls';

import { ResponseInterceptor } from './response.interceptor.js';

function httpContext(): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'accept-language': 'en' } }),
    }),
  } as unknown as ExecutionContext;
}

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor({
    get: () => 'correlation-1',
  } as unknown as ClsService);

  it('wraps an ordinary answer in the envelope', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(httpContext(), { handle: () => of({ a: 1 }) }),
    );
    expect(result).toMatchObject({ success: true, data: { a: 1 } });
  });

  it('passes a file download through untouched, so its bytes stay a file', async () => {
    const file = new StreamableFile(Buffer.from('%PDF-1.3'), {
      type: 'application/pdf',
    });

    const result = await firstValueFrom(
      interceptor.intercept(httpContext(), { handle: () => of(file) }),
    );

    expect(result).toBe(file);
  });
});
