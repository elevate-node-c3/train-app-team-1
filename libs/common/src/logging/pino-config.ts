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
        // The single place service and correlation id are stamped. pino-http's
        // `customProps` is deliberately unused: it binds its result onto a
        // child logger at request start, when the correlation id is not in the
        // store yet, and binds it a second time at response finish — three
        // copies of both keys per request log. Reading the store here, per
        // record, keeps one copy and the value that was current when the line
        // was written. It also covers gRPC and consumer logs, which have no
        // request to carry props.
        log: ({ req, res, err, ...rest }: Record<string, unknown>) => {
          const correlationId = cls.get<string>(CORRELATION_ID_KEY);
          return {
            service: currentService,
            ...(correlationId ? { correlationId } : {}),
            // pino runs this formatter before the serializers, so whatever is
            // returned here is what they receive. `req`/`res`/`err` must stay
            // the live objects: `redactPii` rebuilds plain copies without a
            // prototype, and the response serializer reads `headersSent` from
            // there — through a copy it sees `undefined` and reports every
            // status as null. Each of the three redacts its own projection.
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
        // Not run through `redactPii`: a status code carries nothing personal,
        // and `statusCode` matches that redactor's `code` rule.
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
