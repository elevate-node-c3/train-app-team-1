import {
  resolveMessageWithParams,
  type SupportedLanguage,
} from './catalogue.js';

export const ACTION_DEFAULT_KEY = 'ACTION_DEFAULT';
export const ISSUE_FALLBACK_KEY = 'ISSUE_VALIDATION_FAILED';

export const CONSTRAINT_ISSUE_KEYS: Record<string, string> = {
  isUuid: 'ISSUE_MUST_BE_UUID',
  isInt: 'ISSUE_MUST_BE_WHOLE_NUMBER',
  min: 'ISSUE_BELOW_MINIMUM',
  max: 'ISSUE_ABOVE_MAXIMUM',
  matches: 'ISSUE_WRONG_FORMAT',
  isBoolean: 'ISSUE_MUST_BE_YES_OR_NO',
  isIn: 'ISSUE_NOT_AN_ALLOWED_VALUE',
  isString: 'ISSUE_MUST_BE_TEXT',
  isArray: 'ISSUE_MUST_BE_LIST',
  isNotEmpty: 'ISSUE_REQUIRED',
  isDefined: 'ISSUE_REQUIRED',
  isEmail: 'ISSUE_MUST_BE_EMAIL',
  whitelistValidation: 'ISSUE_UNKNOWN_FIELD',
  isIso8601: 'ISSUE_ISO_DATE_TIME_FORMAT',
  minLength: 'ISSUE_TEXT_TOO_SHORT',
  maxLength: 'ISSUE_TEXT_TOO_LONG',
  arrayMinSize: 'ISSUE_LIST_TOO_SHORT',
};

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
  ISSUE_ISO_DATE_TIME_FORMAT: {
    ar: 'يجب أن تكون هذه القيمة تاريخاً أو وقتاً صالحاً على صورة ISO-8601.',
    en: 'This value must be a valid date or time in ISO-8601 format.',
  },
  ISSUE_TEXT_TOO_SHORT: {
    ar: 'هذا النص أقصر من الحد الأدنى للطول المسموح به.',
    en: 'This text is shorter than the minimum allowed length.',
  },
  ISSUE_TEXT_TOO_LONG: {
    ar: 'هذا النص أطول من الحد الأقصى للطول المسموح به.',
    en: 'This text is longer than the maximum allowed length.',
  },
  ISSUE_LIST_TOO_SHORT: {
    ar: 'تحتوي هذه القائمة على عناصر أقل من الحد الأدنى المسموح به.',
    en: 'This list contains fewer items than the minimum allowed.',
  },
  ISSUE_CIVIL_DATE_FORMAT: {
    ar: 'يجب كتابة هذا التاريخ على صورة YYYY-MM-DD.',
    en: 'This date must be written as YYYY-MM-DD.',
  },
  ISSUE_TRAIN_NUMBER_NOT_A_NUMBER: {
    ar: 'رقم القطار يجب أن يكون عدداً صحيحاً.',
    en: 'A train number must be a whole number.',
  },
  ISSUE_TRAIN_NUMBER_TOO_SMALL: {
    ar: 'رقم القطار يبدأ من 1.',
    en: 'A train number starts at 1.',
  },
  ISSUE_SORT_NOT_OFFERED: {
    ar: 'هذا ليس من ترتيبات الفرز المتاحة.',
    en: 'This is not one of the offered sort orders.',
  },
  ISSUE_TRAIN_TYPE_LIST_MALFORMED: {
    ar: 'أنواع القطارات يجب أن تكون قائمة معرفات مفصولة بفواصل.',
    en: 'Train types must be a comma-separated list of identifiers.',
  },
  ISSUE_CLOCK_TIME_FORMAT: {
    ar: 'يجب كتابة هذا الوقت على صورة HH:mm.',
    en: 'This time must be written as HH:mm.',
  },
  ISSUE_FARE_NOT_A_NUMBER: {
    ar: 'الأجرة يجب أن تكون عدداً صحيحاً من القروش.',
    en: 'A fare must be a whole number of piastres.',
  },
  ISSUE_FARE_NEGATIVE: {
    ar: 'الأجرة لا يمكن أن تكون سالبة.',
    en: 'A fare cannot be negative.',
  },
  ISSUE_VERIFICATION_CODE_FORMAT: {
    ar: 'رمز التحقق يجب أن يتكوّن من ستة أرقام فقط.',
    en: 'This verification code must contain exactly six digits.',
  },
  ISSUE_SAME_STATION_AS_ORIGIN: {
    ar: 'محطة الوصول هي نفس محطة المغادرة.',
    en: 'The destination is the same as the origin.',
  },
  ACTION_PICK_DIFFERENT_DESTINATION: {
    ar: 'اختر محطة وصول مختلفة.',
    en: 'Pick a different destination station.',
  },
  ACTION_PICK_RETURN_DATE_ON_OR_AFTER: {
    ar: 'اختر تاريخ عودة في {{departureDate}} أو بعده.',
    en: 'Pick a return date on or after {{departureDate}}.',
  },
  ISSUE_STATION_NOT_KNOWN: {
    ar: 'هذه المحطة غير موجودة في الشبكة.',
    en: 'This station is not in the network.',
  },
  ISSUE_STATION_NOT_ACTIVE: {
    ar: 'هذه المحطة ليست في الخدمة.',
    en: 'This station is not in service.',
  },
  ISSUE_SEAT_CLASS_REQUIRED: {
    ar: 'تحديد درجة المقعد مطلوب.',
    en: 'A seat class is required.',
  },
  ISSUE_SEAT_CLASS_NOT_OFFERED: {
    ar: 'درجة المقعد هذه غير متاحة.',
    en: 'This seat class is not offered.',
  },
  ISSUE_TRAIN_NUMBER_NOT_KNOWN: {
    ar: 'هذا ليس رقم قطار.',
    en: 'This is not a train number.',
  },
  ISSUE_TRAIN_NUMBER_NOT_IN_SERVICE: {
    ar: 'لا يوجد قطار في الخدمة بهذا الرقم.',
    en: 'No train in service carries this number.',
  },
  ISSUE_NOT_A_CALENDAR_DATE: {
    ar: 'هذا التاريخ ليس يوماً صالحاً في التقويم.',
    en: 'This date is not a real calendar day.',
  },
  ISSUE_DATE_IN_THE_PAST: {
    ar: 'هذا التاريخ قد مضى.',
    en: 'This date is in the past.',
  },
  ISSUE_DATE_BEYOND_BOOKING_WINDOW: {
    ar: 'هذا التاريخ خارج الفترة المتاحة للحجز حالياً.',
    en: 'This date is beyond the dates currently open for booking.',
  },
  ISSUE_RETURN_BEFORE_DEPARTURE: {
    ar: 'تاريخ العودة يقع قبل تاريخ المغادرة.',
    en: 'The return date falls before the departure date.',
  },
  ISSUE_TRAIN_TYPE_NOT_KNOWN: {
    ar: 'نوع القطار هذا غير موجود.',
    en: 'This train type does not exist.',
  },
  ISSUE_NOT_A_TIME_OF_DAY: {
    ar: 'هذا ليس وقتاً من اليوم.',
    en: 'This is not a time of day.',
  },
  ISSUE_WINDOW_ENDS_BEFORE_IT_STARTS: {
    ar: 'هذا الوقت ليس بعد أبكر وقت للمغادرة.',
    en: 'This time is not after the earliest departure time.',
  },
  ISSUE_NOT_A_FARE_AMOUNT: {
    ar: 'هذا ليس مبلغ أجرة بالقروش.',
    en: 'This is not a fare amount in piastres.',
  },
  ISSUE_OUTBOUND_TRIP_ID_MALFORMED: {
    ar: 'معرف رحلة الذهاب هذا غير صالح.',
    en: 'This outbound trip identifier is not valid.',
  },
  ISSUE_OUTBOUND_TRIP_GONE: {
    ar: 'هذه الرحلة لم تعد متاحة بين هاتين المحطتين.',
    en: 'This trip is no longer available between those stations.',
  },
  ISSUE_TRIP_DOES_NOT_SERVE_PAIR: {
    ar: 'هذه الرحلة لا تتوقف في هاتين المحطتين بهذا الترتيب.',
    en: 'This trip does not stop at these stations in this order.',
  },
  ACTION_PICK_STATION_FROM_LIST: {
    ar: 'اختر محطة من قائمة المحطات.',
    en: 'Pick a station from the station list.',
  },
  ACTION_PICK_ANOTHER_STATION: {
    ar: 'اختر محطة أخرى من قائمة المحطات.',
    en: 'Pick another station from the station list.',
  },
  ACTION_PICK_SEAT_CLASS: {
    ar: 'اختر درجة المقعد.',
    en: 'Choose a seat class.',
  },
  ACTION_PICK_SEAT_CLASS_FROM_LIST: {
    ar: 'اختر درجة المقعد من القائمة.',
    en: 'Choose a seat class from the list.',
  },
  ACTION_FIX_OR_CLEAR_TRAIN_NUMBER: {
    ar: 'صحح رقم القطار، أو امسحه لعرض كل القطارات.',
    en: 'Correct the train number, or clear it to see every train.',
  },
  ACTION_PICK_DATE_FROM_CALENDAR: {
    ar: 'اختر تاريخاً من التقويم.',
    en: 'Pick a date from the calendar.',
  },
  ACTION_PICK_RETURN_DATE_FROM_CALENDAR: {
    ar: 'اختر تاريخ العودة من التقويم.',
    en: 'Pick a return date from the calendar.',
  },
  ACTION_PICK_DATE_IN_BOOKING_WINDOW: {
    ar: 'اختر تاريخاً بين {{firstBookableDate}} و{{lastBookableDate}}.',
    en: 'Pick a date between {{firstBookableDate}} and {{lastBookableDate}}.',
  },
  ACTION_PICK_TRAIN_TYPE_FROM_LIST: {
    ar: 'اختر نوع القطار من القائمة.',
    en: 'Choose a train type from the list.',
  },
  ACTION_PICK_TIME_IN_DAY: {
    ar: 'اختر وقتاً بين 00:00 و23:59.',
    en: 'Pick a time between 00:00 and 23:59.',
  },
  ACTION_PICK_LATER_TIME_OR_CLEAR: {
    ar: 'اختر وقتاً لاحقاً، أو اتركه فارغاً.',
    en: 'Pick a later time, or leave it empty.',
  },
  ACTION_FIX_OR_CLEAR_MAX_FARE: {
    ar: 'أدخل مبلغاً بالقروش، أو امسحه لعرض كل الأسعار.',
    en: 'Enter an amount in piastres, or clear it to see every price.',
  },
  ACTION_CHOOSE_SOLD_OUT_PREFERENCE: {
    ar: 'حدد ما إذا كنت تريد إخفاء الرحلات المكتملة.',
    en: 'Choose whether to hide sold-out trips.',
  },
  ACTION_SEARCH_AGAIN_FOR_OUTBOUND: {
    ar: 'ابحث مرة أخرى واختر رحلة ذهاب.',
    en: 'Search again and choose an outbound trip.',
  },
  ACTION_SEARCH_AGAIN_WITH_ANOTHER_STATION: {
    ar: 'ابحث مرة أخرى بمحطة أخرى.',
    en: 'Search again with another station.',
  },
  ACTION_PICK_TRIP_FROM_RESULTS: {
    ar: 'اختر رحلة من نتائج البحث وافتح محطات توقفها مرة أخرى.',
    en: 'Pick a trip from the search results and open its stops again.',
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
