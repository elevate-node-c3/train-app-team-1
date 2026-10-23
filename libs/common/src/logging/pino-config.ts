import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClsService } from 'nestjs-cls';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from '../correlation/correlation.constants.js';
import { redactPii } from './pii-redactor.js';

export function createPinoConfig(
  cls: ClsService,
  serviceName?: string,
): Params {
  const currentService = serviceName || process.env.APP || 'unknown';

  return {
    pinoHttp: {
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label: string) => ({ level: label }),
        log: (object: Record<string, unknown>) => {
          const redacted = redactPii(object);
          const correlationId = cls.get<string>(CORRELATION_ID_KEY);
          return {
            service: currentService,
            ...(correlationId ? { correlationId } : {}),
            ...redacted,
          };
        },
      },
      serializers: {
        req: (req: any) => ({
          method: req.method,
          url: req.url,
          headers: {
            host: req.headers?.host,
            'user-agent': req.headers?.['user-agent'],
            'x-correlation-id': req.headers?.['x-correlation-id'],
            'accept-language': req.headers?.['accept-language'],
          },
          remoteAddress: req.remoteAddress,
        }),
        res: (res: any) => ({
          statusCode: res.statusCode,
        }),
        err: (err: any) => ({
          type: err?.type || err?.name,
          message: err?.message,
          stack: err?.stack,
        }),
      },
      customProps: (req: IncomingMessage, _res: ServerResponse) => {
        const correlationId =
          cls.get<string>(CORRELATION_ID_KEY) ||
          req.headers[CORRELATION_ID_HEADER] ||
          'none';
        return {
          service: currentService,
          correlationId: String(correlationId),
        };
      },
      redact: {
        paths: [
          'password',
          '*.password',
          'secret',
          '*.secret',
          'token',
          '*.token',
          'pin',
          '*.pin',
          'code',
          '*.code',
          'verificationCode',
          '*.verificationCode',
          'cardNumber',
          '*.cardNumber',
          'cvv',
          '*.cvv',
          'nationalId',
          '*.nationalId',
          'phone',
          '*.phone',
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
          'req.body.pin',
        ],
        censor: '[REDACTED]',
      },
      autoLogging: {
        ignore: (req) => req.url === '/health/live',
      },
    },
  };
}
