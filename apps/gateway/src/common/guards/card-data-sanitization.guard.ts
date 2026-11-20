import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';

const FORBIDDEN_CARD_KEY_REGEX =
  /^(card_?number|pan|cvv|cvc|card_?code|expiry|exp_month|exp_year|expiration)$/i;

/**
 * BR-32 & PCI DSS Scope Reduction:
 * No ENR endpoint may receive Primary Account Numbers, CVVs, or raw card data.
 * This guard runs before ValidationPipe to reject any forbidden fields immediately
 * without mirroring or echoing their values back into HTTP responses or logs.
 */
@Injectable()
export class CardDataSanitizationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ body?: unknown; query?: unknown; headers?: unknown }>();

    const checkObject = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) checkObject(item);
        return;
      }
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        if (FORBIDDEN_CARD_KEY_REGEX.test(key)) {
          throw new HttpException(
            { code: ErrorCode.INVALID_PAYLOAD },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (typeof value === 'object' && value !== null) {
          checkObject(value);
        }
      }
    };

    checkObject(request.body);
    checkObject(request.query);
    return true;
  }
}
