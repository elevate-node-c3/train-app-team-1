import { ErrorCode } from '@app/contracts';

export type SupportedLanguage = 'ar' | 'en';

/**
 * Domain Event Catalogue Note:
 * Saved passenger CRUD events (add, update, delete) are intentionally NOT published
 * to the message broker / outbox. The booking service reads passenger details
 * directly from identity during hold creation in Sprint 3, eliminating unnecessary
 * event fan-out and companion roster duplication.
 */

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

  // Profile completion
  [ErrorCode.PROFILE_ALREADY_COMPLETE]: {
    ar: 'تم إكمال الملف الشخصي مسبقاً',
    en: 'Profile is already complete',
  },
  [ErrorCode.INVALID_FULL_NAME]: {
    ar: 'الاسم بالكامل غير صالح، يجب إدخال الاسم الأول واسم العائلة على الأقل وبحد أقصى 50 حرفاً',
    en: 'Invalid full name; must include at least first and family name with a maximum of 50 characters',
  },
  [ErrorCode.INVALID_NATIONAL_ID_LENGTH]: {
    ar: 'الرقم القومي غير صالح، يجب أن يتكون من 14 رقماً بالضبط',
    en: 'Invalid National ID; must be exactly 14 digits',
  },
  [ErrorCode.INVALID_NATIONAL_ID_CENTURY]: {
    ar: 'الرقم القومي غير صالح، رقم القرن غير صحيح',
    en: 'Invalid National ID; invalid century digit',
  },
  [ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE]: {
    ar: 'الرقم القومي غير صالح، تاريخ الميلاد غير صحيح أو في المستقبل',
    en: 'Invalid National ID; birth date is invalid or in the future',
  },
  [ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE]: {
    ar: 'الرقم القومي غير صالح، كود المحافظة غير صحيح',
    en: 'Invalid National ID; invalid governorate code',
  },
  [ErrorCode.NATIONAL_ID_ALREADY_REGISTERED]: {
    ar: 'الرقم القومي مسجل بالفعل لحساب آخر',
    en: 'This National ID is already registered to another account',
  },
  [ErrorCode.INVALID_PHONE_FORMAT]: {
    ar: 'رقم الهاتف غير صالح، يجب أن يكون رقم هاتف مصري صحيح يبدأ بـ 01',
    en: 'Invalid phone number; must be a valid Egyptian mobile number starting with 01',
  },
  [ErrorCode.PHONE_ALREADY_REGISTERED]: {
    ar: 'رقم الهاتف مسجل بالفعل',
    en: 'This phone number is already registered',
  },
  [ErrorCode.INVALID_PROFILE_TYPE]: {
    ar: 'نوع الملف الشخصي غير صالح',
    en: 'Invalid profile type',
  },
  [ErrorCode.INVALID_NATIONALITY]: {
    ar: 'الجنسية غير صالحة',
    en: 'Invalid nationality',
  },

  // Saved passengers
  [ErrorCode.PASSENGER_NOT_FOUND]: {
    ar: 'المسافر غير موجود',
    en: 'Passenger not found',
  },
  [ErrorCode.PASSENGER_LIMIT_REACHED]: {
    ar: 'تم الوصول إلى الحد الأقصى للمسافرين (10 مسافرين)',
    en: 'Passenger limit reached (maximum 10 companions)',
  },
  [ErrorCode.CANNOT_DELETE_SELF_PASSENGER]: {
    ar: 'لا يمكن حذف المسافر الأساسي',
    en: 'Cannot delete self passenger',
  },
  [ErrorCode.NATIONAL_ID_LOCKED]: {
    ar: 'لا يمكن تعديل الرقم القومي بعد إصدار التذكرة',
    en: 'National ID cannot be changed once a ticket has been issued',
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
