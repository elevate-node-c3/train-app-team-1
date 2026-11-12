import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { INTERNAL_CALLER_HEADER_PREFIXES } from './caller-metadata.constants.js';

/** Strip spoofed caller headers before guards or controllers can read them. */
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
