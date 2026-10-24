import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { v4 as uuidv4 } from 'uuid';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from './correlation.constants.js';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const isGateway = process.env.APP === 'gateway';

    let correlationId: string;
    if (isGateway) {
      // Gateway ALWAYS generates an immutable correlation ID; client-sent values never replace it.
      correlationId = uuidv4();
    } else {
      const incoming = req.headers[CORRELATION_ID_HEADER];
      if (typeof incoming === 'string' && incoming.trim().length > 0) {
        correlationId = incoming.trim();
      } else {
        correlationId = uuidv4();
      }
    }

    this.cls.set(CORRELATION_ID_KEY, correlationId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
