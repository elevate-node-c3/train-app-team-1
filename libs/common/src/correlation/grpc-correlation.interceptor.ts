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
import {
  CALLER_ACCOUNT_ID_HEADER,
  CALLER_ACCOUNT_ID_KEY,
  CALLER_BOOKABLE_HEADER,
  CALLER_BOOKABLE_KEY,
  CALLER_JTI_HEADER,
  CALLER_JTI_KEY,
  CALLER_ROLES_HEADER,
  CALLER_ROLES_KEY,
  CALLER_SESSION_ID_HEADER,
  CALLER_SESSION_ID_KEY,
} from '../caller/caller-metadata.constants.js';

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
          this.setCaller(metadata);
          next.handle().subscribe(subscriber);
        });
      });
    }

    return next.handle();
  }

  /**
   * Identity reads the caller from these headers only after the gateway has
   * minted them from a verified token. A client that sends them directly never
   * reaches this interceptor: the gateway strips the whole prefix first.
   */
  private setCaller(metadata: Metadata): void {
    if (!metadata || typeof metadata.get !== 'function') return;

    const first = (key: string): string | undefined => {
      const values = metadata.get(key);
      return values.length > 0 && typeof values[0] === 'string'
        ? values[0]
        : undefined;
    };

    const accountId = first(CALLER_ACCOUNT_ID_HEADER);
    const sessionId = first(CALLER_SESSION_ID_HEADER);
    const jti = first(CALLER_JTI_HEADER);
    const roles = first(CALLER_ROLES_HEADER);
    const bookable = first(CALLER_BOOKABLE_HEADER);

    if (accountId) this.cls.set(CALLER_ACCOUNT_ID_KEY, accountId);
    if (sessionId) this.cls.set(CALLER_SESSION_ID_KEY, sessionId);
    if (jti) this.cls.set(CALLER_JTI_KEY, jti);
    if (roles !== undefined) {
      this.cls.set(
        CALLER_ROLES_KEY,
        roles.length > 0 ? roles.split(',') : [],
      );
    }
    if (bookable === 'true' || bookable === 'false') {
      this.cls.set(CALLER_BOOKABLE_KEY, bookable === 'true');
    }
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

/**
 * Correlation plus the verified caller. Only the gateway calls this: identity
 * and the other services read these values from the transport, never from an
 * inbound HTTP header.
 */
export function createGrpcMetadataWithCaller(
  cls: ClsService,
  existingMetadata?: Metadata,
): Metadata {
  const metadata = createGrpcMetadataWithCorrelation(cls, existingMetadata);

  const accountId = cls.get<string>(CALLER_ACCOUNT_ID_KEY);
  const sessionId = cls.get<string>(CALLER_SESSION_ID_KEY);
  const jti = cls.get<string>(CALLER_JTI_KEY);
  const roles = cls.get<string[]>(CALLER_ROLES_KEY);
  const bookable = cls.get<boolean>(CALLER_BOOKABLE_KEY);

  if (accountId) metadata.set(CALLER_ACCOUNT_ID_HEADER, accountId);
  if (sessionId) metadata.set(CALLER_SESSION_ID_HEADER, sessionId);
  if (jti) metadata.set(CALLER_JTI_HEADER, jti);
  if (roles?.length) metadata.set(CALLER_ROLES_HEADER, roles.join(','));
  if (typeof bookable === 'boolean') {
    metadata.set(CALLER_BOOKABLE_HEADER, String(bookable));
  }

  return metadata;
}
