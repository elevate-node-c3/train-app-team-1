import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { INTERNAL_CALLER_HEADER_PREFIXES } from './caller-metadata.constants.js';

/**
 * The caller-metadata twin of `CorrelationMiddleware`: the gateway mints, no
 * one trusts the client. Stripping here, before guards or controllers, means a
 * spoofed header has no reader at all rather than several that must remember
 * not to trust it.
 */
@Injectable()
export class CallerMetadataMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    for (const name of Object.keys(req.headers)) {
      if (
        INTERNAL_CALLER_HEADER_PREFIXES.some((prefix) =>
          name.toLowerCase().startsWith(prefix),
        )
      ) {
        delete req.headers[name];
      }
    }
    next();
  }
}
