import { ErrorCode } from '@app/contracts';

export type SupportedLanguage = 'ar' | 'en';

/**
 * A refused search date, carrying the last date the traveller could pick
 * instead. Not a `SearchEmptyReason`: the search was refused, not answered
 * with an empty list.
 */
export const CATALOG_SEARCH_DATE_OUT_OF_WINDOW =
  'CATALOG_SEARCH_DATE_OUT_OF_WINDOW';

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
  [ErrorCode.RESOURCE_NOT_FOUND]: {
    ar: 'العنصر المطلوب غير موجود',
    en: 'The requested resource was not found',
  },
  [ErrorCode.CONFLICT]: {
    ar: 'تعارض في حالة المورد، يرجى إعادة المحاولة',
    en: 'The resource is in a conflicting state, please retry',
  },
  [ErrorCode.GATEWAY_TIMEOUT]: {
    ar: 'استغرق الطلب وقتاً أطول من المسموح، يرجى إعادة المحاولة',
    en: 'The request took longer than allowed, please try again',
  },
  [ErrorCode.NOT_IMPLEMENTED]: {
    ar: 'هذه العملية غير مدعومة حالياً',
    en: 'This operation is not supported yet',
  },
  [ErrorCode.RATE_LIMITED]: {
    ar: 'تم تجاوز الحد المسموح من المحاولات، يرجى المحاولة لاحقاً',
    en: 'Too many attempts, please try again later',
  },
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: {
    ar: 'هذا البريد الإلكتروني مسجل بالفعل، يرجى تسجيل الدخول أو استعادة كلمة المرور',
    en: 'This email is already registered, please sign in or recover your password',
  },
  [ErrorCode.EMAIL_NOT_VERIFIED]: {
    ar: 'يجب تأكيد البريد الإلكتروني قبل تسجيل الدخول',
    en: 'Please verify your email before signing in',
  },
  [ErrorCode.VERIFICATION_REQUIRED]: {
    ar: 'مطلوب تأكيد البريد الإلكتروني، تم إرسال رمز تحقق جديد إن كان مسموحاً',
    en: 'Email verification is required; a new code was sent if allowed',
  },
  [ErrorCode.INVALID_VERIFICATION_CODE]: {
    ar: 'رمز التحقق غير صحيح',
    en: 'The verification code is incorrect',
  },
  [ErrorCode.VERIFICATION_CODE_EXPIRED]: {
    ar: 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد',
    en: 'The verification code has expired, please request a new one',
  },
  [ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED]: {
    ar: 'تم استهلاك جميع محاولات رمز التحقق، يرجى طلب رمز جديد',
    en: 'All attempts for this verification code are exhausted, please request a new one',
  },
  [ErrorCode.RESEND_TOO_SOON]: {
    ar: 'يرجى الانتظار قبل طلب رمز تحقق جديد',
    en: 'Please wait before requesting another verification code',
  },
  [ErrorCode.INVALID_CREDENTIALS]: {
    ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
    en: 'The email or password is incorrect',
  },
  [ErrorCode.ACCOUNT_LOCKED]: {
    ar: 'تم قفل الحساب مؤقتاً بسبب محاولات دخول خاطئة متكررة',
    en: 'The account is temporarily locked after repeated failed sign-in attempts',
  },
  [ErrorCode.ACCOUNT_DISABLED]: {
    ar: 'تم تعطيل هذا الحساب',
    en: 'This account has been disabled',
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    ar: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول من جديد',
    en: 'Your session has expired, please sign in again',
  },
  [ErrorCode.TOKEN_INVALID]: {
    ar: 'رمز الدخول غير صالح',
    en: 'The access token is invalid',
  },
  [ErrorCode.TOKEN_REVOKED]: {
    ar: 'تم إلغاء الجلسة، يرجى تسجيل الدخول من جديد',
    en: 'The session has been revoked, please sign in again',
  },
  [ErrorCode.INVALID_REFRESH_TOKEN]: {
    ar: 'رمز تحديث الجلسة غير صالح',
    en: 'The refresh token is invalid',
  },
  [ErrorCode.REFRESH_TOKEN_REUSE_DETECTED]: {
    ar: 'تم اكتشاف إعادة استخدام رمز تحديث الجلسة، وتم إلغاء الجلسة',
    en: 'Refresh token reuse was detected and the session was revoked',
  },
  [ErrorCode.SESSION_REVOKED]: {
    ar: 'تم إنهاء الجلسة',
    en: 'The session has been revoked',
  },
  [ErrorCode.PASSWORD_REUSE]: {
    ar: 'يجب أن تختلف كلمة المرور الجديدة عن كلمة المرور الحالية',
    en: 'The new password must differ from the current password',
  },
  [ErrorCode.PASSWORD_RESET_INVALID]: {
    ar: 'رمز استعادة كلمة المرور غير صالح أو منتهي',
    en: 'The password reset code is invalid or expired',
  },
  [ErrorCode.PROFILE_INCOMPLETE]: {
    ar: 'يجب إكمال الملف الشخصي قبل إتمام الحجز',
    en: 'Please complete your profile before making a booking',
  },

  // --- Trip search (TA-17) -------------------------------------------------
  //
  // Keyed by the `SearchEmptyReason` wire values themselves, so the gateway
  // needs no mapping table between the gRPC response and the sentence. These
  // are not ErrorCodes on purpose: an empty result is a 200 with success
  // true, not an error. The catalogue is Record<string, ...> and
  // resolveMessage takes a string, so no enum has to grow for this.
  //
  // The three must read differently in both languages. BR-57 exists because
  // travellers reported "I don't know what to change: station, date, or
  // round-trip option" -- so each sentence names the field to change.
  SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED: {
    ar: 'لا يوجد قطار يسير بين هاتين المحطتين في هذا الاتجاه، يرجى تغيير المحطتين',
    en: 'No train runs between these stations in this direction, please change the stations',
  },
  SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE: {
    ar: 'عفوا, لا يوجد مواعيد متاحة في التاريخ المختار',
    en: 'Sorry, no trains available on the selected date',
  },
  SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE: {
    ar: 'هذا القطار لا يخدم هذا المسار، يرجى تغيير رقم القطار أو إزالته',
    en: 'This train does not serve this route, please change or clear the train number',
  },
  [CATALOG_SEARCH_DATE_OUT_OF_WINDOW]: {
    ar: 'التاريخ المختار خارج فترة الحجز المتاحة، آخر تاريخ متاح للحجز هو {{lastBookableDate}}',
    en: 'The selected date is outside the booking window; the last bookable date is {{lastBookableDate}}',
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

/**
 * Resolves a message and substitutes `{{name}}` placeholders.
 *
 * Catalog supplies values and the edge supplies words: a refused search date
 * travels as a reason plus `{ lastBookableDate }`, and the sentence that
 * quotes it is assembled here. That is what keeps catalog free of any
 * language and keeps Accept-Language resolved in one place.
 *
 * An unsupplied placeholder is left verbatim rather than printed as
 * "undefined" -- a visible `{{lastBookableDate}}` is a bug report, while
 * "the last bookable date is undefined" is a lie told to a traveller.
 */
export function resolveMessageWithParams(
  code: string,
  lang: SupportedLanguage = 'ar',
  params: Record<string, string> = {},
): string {
  return resolveMessage(code, lang).replace(
    /\{\{(\w+)\}\}/g,
    (placeholder, name: string) => params[name] ?? placeholder,
  );
}
