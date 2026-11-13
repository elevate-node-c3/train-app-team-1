import type { Params } from 'nestjs-pino';
import { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY } from '../correlation/correlation.constants.js';
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
        // Read service and correlation ID once per record, not via customProps.
        // Request-start bindings run before CLS and duplicate fields at response
        // time. Per-record lookup also covers gRPC and consumer logs.
        log: ({ req, res, err, ...rest }: Record<string, unknown>) => {
          const correlationId = cls.get<string>(CORRELATION_ID_KEY);
          return {
            service: currentService,
            ...(correlationId ? { correlationId } : {}),
            // Serializers run later and need live req/res/err objects, including
            // prototype fields such as res.headersSent. Each redacts its own
            // projection; redactPii here would lose those fields.
            ...(req !== undefined ? { req } : {}),
            ...(res !== undefined ? { res } : {}),
            ...(err !== undefined ? { err } : {}),
            ...redactPii(rest),
          };
        },
      },
      serializers: {
        req: (req: any) =>
          redactPii({
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
        // statusCode is not PII but matches redactPii's broad "code" rule.
        res: (res: any) => ({
          statusCode: res.statusCode,
        }),
        err: (err: any) =>
          redactPii({
            type: err?.type || err?.name,
            message: err?.message,
            stack: err?.stack,
          }),
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
