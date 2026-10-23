import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';
import { Metadata } from '@grpc/grpc-js';
import { v4 as uuidv4 } from 'uuid';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from './correlation.constants.js';

@Injectable()
export class GrpcCorrelationInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'rpc') {
      const rpcContext = context.switchToRpc();
      const metadata: Metadata = rpcContext.getContext();

      let correlationId: string | undefined;
      if (metadata && typeof metadata.get === 'function') {
        const values = metadata.get(CORRELATION_ID_HEADER);
        if (values && values.length > 0 && typeof values[0] === 'string') {
          correlationId = values[0];
        }
      }

      if (!correlationId) {
        correlationId = uuidv4();
      }

      return new Observable((subscriber) => {
        this.cls.run(() => {
          this.cls.set(CORRELATION_ID_KEY, correlationId);
          next.handle().subscribe(subscriber);
        });
      });
    }

    return next.handle();
  }
}

/**
 * Creates outgoing gRPC metadata carrying the current correlation ID from ClsService.
 */
export function createGrpcMetadataWithCorrelation(
  cls: ClsService,
  existingMetadata?: Metadata,
): Metadata {
  const metadata = existingMetadata ? existingMetadata.clone() : new Metadata();
  const correlationId = cls.get<string>(CORRELATION_ID_KEY) || uuidv4();
  metadata.set(CORRELATION_ID_HEADER, correlationId);
  return metadata;
}
