import {
  resolveMessageWithParams,
  type SupportedLanguage,
} from './catalogue.js';

export const ACTION_DEFAULT_KEY = 'ACTION_DEFAULT';
export const ISSUE_FALLBACK_KEY = 'ISSUE_VALIDATION_FAILED';

export const DETAIL_CATALOGUE: Record<string, { ar: string; en: string }> = {
  ACTION_DEFAULT: {
    ar: 'أرسل قيمة تطابق شروط هذا الحقل.',
    en: "Send a value that meets this field's constraints.",
  },
  ISSUE_VALIDATION_FAILED: {
    ar: 'هذه القيمة غير صالحة.',
    en: 'This value is not valid.',
  },
  ISSUE_MUST_BE_UUID: {
    ar: 'يجب أن تكون هذه القيمة معرفاً صالحاً.',
    en: 'This value must be a valid identifier.',
  },
  ISSUE_MUST_BE_WHOLE_NUMBER: {
    ar: 'يجب أن تكون هذه القيمة عدداً صحيحاً.',
    en: 'This value must be a whole number.',
  },
  ISSUE_BELOW_MINIMUM: {
    ar: 'هذه القيمة أقل من الحد الأدنى المسموح به.',
    en: 'This value is below the smallest allowed.',
  },
  ISSUE_ABOVE_MAXIMUM: {
    ar: 'هذه القيمة أكبر من الحد الأقصى المسموح به.',
    en: 'This value is above the largest allowed.',
  },
  ISSUE_WRONG_FORMAT: {
    ar: 'هذه القيمة ليست بالتنسيق المتوقع.',
    en: 'This value is not in the expected format.',
  },
  ISSUE_MUST_BE_YES_OR_NO: {
    ar: 'يجب أن تكون هذه القيمة إما صحيحة أو خاطئة.',
    en: 'This value must be either true or false.',
  },
  ISSUE_NOT_AN_ALLOWED_VALUE: {
    ar: 'هذه القيمة ليست من الخيارات المقبولة.',
    en: 'This value is not one of the accepted options.',
  },
  ISSUE_MUST_BE_TEXT: {
    ar: 'يجب أن تكون هذه القيمة نصاً.',
    en: 'This value must be text.',
  },
  ISSUE_MUST_BE_LIST: {
    ar: 'يجب أن تكون هذه القيمة قائمة.',
    en: 'This value must be a list.',
  },
  ISSUE_REQUIRED: {
    ar: 'هذه القيمة مطلوبة.',
    en: 'This value is required.',
  },
  ISSUE_MUST_BE_EMAIL: {
    ar: 'هذا ليس عنوان بريد إلكتروني صالحاً.',
    en: 'This is not a valid email address.',
  },
  ISSUE_UNKNOWN_FIELD: {
    ar: 'هذا الحقل غير مقبول في هذا الطلب.',
    en: 'This field is not accepted by this request.',
  },
  ACTION_PICK_RETURN_DATE_ON_OR_AFTER: {
    ar: 'اختر تاريخ عودة في {{departureDate}} أو بعده.',
    en: 'Pick a return date on or after {{departureDate}}.',
  },
};

export function resolveDetailText(
  key: string,
  lang: SupportedLanguage,
  params?: Record<string, string>,
): string {
  return resolveMessageWithParams(
    Object.hasOwn(DETAIL_CATALOGUE, key) ? key : ISSUE_FALLBACK_KEY,
    lang,
    params,
    DETAIL_CATALOGUE,
  );
}
