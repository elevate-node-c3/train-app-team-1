import { ErrorCode } from '@app/contracts';

export type SupportedLanguage = 'ar' | 'en';

export const MESSAGE_CATALOGUE: Record<string, { ar: string; en: string }> = {
  [ErrorCode.SUCCESS]: {
    ar: 'تمت العملية بنجاح',
    en: 'Operation completed successfully',
  },
  [ErrorCode.ALL_SERVICES_READY]: {
    ar: 'جميع الخدمات جاهزة وتعمل بشكل سليم',
    en: 'All services are ready and operational',
  },
  [ErrorCode.SERVICE_DEGRADED]: {
    ar: 'الخدمة تعمل في وضع متدهور (خدمة التخزين المؤقت غير متوفرة)',
    en: 'Service is operating in degraded mode (cache service is unavailable)',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    ar: 'بيانات الطلب غير صالحة، يرجى تصحيح الأخطاء والمحاولة مرة أخرى',
    en: 'The request payload is invalid, please correct the errors and try again',
  },
  [ErrorCode.ROUTE_NOT_FOUND]: {
    ar: 'المسار المطلوب غير موجود',
    en: 'The requested route was not found',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    ar: 'الخدمة غير متوفرة حالياً، يرجى المحاولة لاحقاً',
    en: 'Service is temporarily unavailable, please try again later',
  },
  [ErrorCode.BAD_REQUEST]: {
    ar: 'طلب غير صالح، يرجى التحقق من المدخلات',
    en: 'Bad request, please verify your input',
  },
  [ErrorCode.UNAUTHORIZED]: {
    ar: 'غير مصرح لك بالوصول، يرجى تسجيل الدخول',
    en: 'Unauthorized access, please authenticate',
  },
  [ErrorCode.FORBIDDEN]: {
    ar: 'ليس لديك صلاحية لتنفيذ هذا الإجراء',
    en: 'You do not have permission to perform this action',
  },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    ar: 'حدث خطأ غير متوقع في الخادم، يرجى المحاولة لاحقاً',
    en: 'An unexpected internal server error occurred, please try again later',
  },
};

/**
 * Resolves the requested language from the Accept-Language header.
 * Defaults to 'ar' for missing, unsupported, or wildcard languages (BR-56).
 */
export function resolveLanguage(
  acceptLanguageHeader?: string,
): SupportedLanguage {
  if (!acceptLanguageHeader) {
    return 'ar';
  }

  const normalized = acceptLanguageHeader.toLowerCase();

  // If English is specified (e.g. en, en-us, en-gb)
  const tokens = normalized.split(',').map((t) => t.trim().split(';')[0]);
  for (const token of tokens) {
    if (token.startsWith('en')) {
      return 'en';
    }
    if (token.startsWith('ar')) {
      return 'ar';
    }
  }

  // Fallback to Arabic as documented universal default
  return 'ar';
}

/**
 * Resolves message for code and language from the centralized catalogue (D14).
 */
export function resolveMessage(
  code: string,
  lang: SupportedLanguage = 'ar',
): string {
  const entry = MESSAGE_CATALOGUE[code];
  if (entry && entry[lang]) {
    return entry[lang];
  }
  if (entry && entry.ar) {
    return entry.ar;
  }
  return lang === 'en'
    ? 'An error occurred during request processing'
    : 'حدث خطأ أثناء معالجة الطلب';
}
