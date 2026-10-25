import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pinoHttp, type Options } from 'pino-http';
import type { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY } from '../correlation/correlation.constants.js';
import { createPinoConfig } from './pino-config.js';

/**
 * Drives a real request through the real pino-http middleware. The middleware
 * runs before the correlation id is in the store, which is the production
 * order: nestjs-pino's LoggerModule is imported by CommonModule, so Nest
 * registers its middleware ahead of ClsMiddleware/CorrelationMiddleware.
 */
async function logRequest(
  correlationId: string,
  path = '/api/v1/auth/sign-up',
): Promise<string> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  let current: string | undefined;
  const cls = {
    get: (key: string) => (key === CORRELATION_ID_KEY ? current : undefined),
  } as unknown as ClsService;

  const options = createPinoConfig(cls, 'gateway').pinoHttp as Options;
  const middleware = pinoHttp(options, stream);

  const server = createServer((req, res) => {
    middleware(req, res);
    current = correlationId;
    res.statusCode = 201;
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
    while (!lines.some((line) => line.includes('request completed'))) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    server.close();
    await once(server, 'close');
  }

  return lines.find((line) => line.includes('request completed'))!;
}

describe('createPinoConfig', () => {
  it('stamps service and correlationId exactly once per record', async () => {
    const line = await logRequest('corr-1');

    expect(line.match(/"service":/g)).toHaveLength(1);
    expect(line.match(/"correlationId":/g)).toHaveLength(1);
  });

  it('reports the correlation id resolved at log time, never a placeholder', async () => {
    const line = await logRequest('corr-1');

    expect(JSON.parse(line)).toMatchObject({
      service: 'gateway',
      correlationId: 'corr-1',
      msg: 'request completed',
    });
  });

  it('reports the response status code the handler set', async () => {
    const line = await logRequest('corr-1');

    expect(JSON.parse(line).res).toEqual({ statusCode: 201 });
  });

  it('masks an email carried in the request url', async () => {
    const line = await logRequest(
      'corr-1',
      '/api/v1/auth/sign-up?email=rana@example.com',
    );

    expect(JSON.parse(line).req.url).toBe(
      '/api/v1/auth/sign-up?email=r***@example.com',
    );
  });
});
