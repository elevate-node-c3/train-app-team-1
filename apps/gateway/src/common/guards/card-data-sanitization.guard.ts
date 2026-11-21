import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';

const FORBIDDEN_CARD_KEYS = new Set([
  'number',
  'accountnumber',
  'cardnumber',
  'cardpan',
  'ccnumber',
  'ccn',
  'pan',
  'primaryaccountnumber',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'ccv',
  'ccv2',
  'securitycode',
  'cardsecuritycode',
  'securityvalue',
  'cardcode',
  'code',
  'verificationvalue',
  'expiry',
  'expirydate',
  'expirymonth',
  'expiryyear',
  'expmonth',
  'expyear',
  'expiration',
  'expirationdate',
  'expirationmonth',
  'expirationyear',
  'clientsecret',
  'stripeclientsecret',
  'secretkey',
  'stripesecretkey',
  'stripekey',
]);

const STRIPE_SECRET_VALUE_REGEX =
  /^(?:seti_[a-zA-Z0-9]+_secret_|sk_(?:test|live)_|whsec_)[a-zA-Z0-9_]+$/;
const CARD_NUMBER_VALUE_REGEX = /^\d[\d -]{10,24}\d$/;

/**
 * BR-32 & PCI DSS Scope Reduction:
 * No ENR endpoint may receive Primary Account Numbers, CVVs, or raw card data.
 * This guard runs before ValidationPipe to reject any forbidden fields immediately
 * without mirroring or echoing their values back into HTTP responses or logs.
 */
@Injectable()
export class CardDataSanitizationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      query?: unknown;
      headers?: unknown;
      params?: unknown;
    }>();

    const checkObject = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) checkObject(item);
        return;
      }
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cardFieldKey = normalizedKey.startsWith('card')
          ? normalizedKey.slice('card'.length)
          : normalizedKey;
        const secretFieldKey = normalizedKey.replace(
          /^(?:stripe|paymentintent)/,
          '',
        );
        const stringValue = typeof value === 'string' ? value : '';
        const numericPan =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 1_000_000_000_000 &&
          value < 10_000_000_000_000_000_000;
        if (
          FORBIDDEN_CARD_KEYS.has(normalizedKey) ||
          FORBIDDEN_CARD_KEYS.has(cardFieldKey) ||
          FORBIDDEN_CARD_KEYS.has(secretFieldKey) ||
          STRIPE_SECRET_VALUE_REGEX.test(stringValue) ||
          CARD_NUMBER_VALUE_REGEX.test(stringValue) ||
          numericPan ||
          (normalizedKey === 'setupintentid' &&
            !/^seti_[a-zA-Z0-9]+$/.test(stringValue))
        ) {
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
    checkObject(request.params);
    checkObject(request.headers);
    return true;
  }
}
