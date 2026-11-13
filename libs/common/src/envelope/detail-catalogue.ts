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
  ISSUE_STATION_NOT_FOUND: {
    ar: 'هذه المحطة غير موجودة في قائمة المحطات.',
    en: 'This station does not exist in the station catalog.',
  },
  ACTION_REFRESH_STATIONS: {
    ar: 'حدّث قائمة المحطات واختر محطة موجودة.',
    en: 'Refresh the station list and select an existing station.',
  },
  ISSUE_STATION_CITY_NOT_KNOWN: {
    ar: 'المدينة المحددة لهذه المحطة غير موجودة.',
    en: 'The city selected for this station does not exist.',
  },
  ACTION_PICK_STATION_CITY: {
    ar: 'اختر مدينة موجودة للمحطة.',
    en: 'Select an existing city for the station.',
  },
  ISSUE_STATION_PATCH_EMPTY: {
    ar: 'هذا الطلب لا يتضمن أي تغيير في المحطة.',
    en: 'This request contains no station changes.',
  },
  ACTION_SEND_STATION_CHANGES: {
    ar: 'أرسل حقلاً واحداً على الأقل لتحديث المحطة.',
    en: 'Send at least one field to update the station.',
  },
  ISSUE_STATION_NAME_INVALID: {
    ar: 'اسم المحطة يجب ألا يكون فارغاً وألا يتجاوز 120 حرفاً.',
    en: 'A station name must not be blank or longer than 120 characters.',
  },
  ACTION_SET_BILINGUAL_STATION_NAME: {
    ar: 'أدخل اسماً غير فارغ للمحطة بالعربية والإنجليزية، حتى 120 حرفاً لكل اسم.',
    en: 'Provide nonblank Arabic and English station names, each at most 120 characters.',
  },
  ISSUE_STATION_ALIASES_INVALID: {
    ar: 'قائمة الأسماء البديلة يجب أن تحتوي على 100 اسم غير فارغ كحد أقصى، حتى 120 حرفاً لكل اسم.',
    en: 'Alternative spellings must contain at most 100 nonblank names, each at most 120 characters.',
  },
  ACTION_SET_STATION_ALIASES: {
    ar: 'أرسل قائمة أسماء بديلة صالحة، أو قائمة فارغة لمسحها.',
    en: 'Send valid alternative spellings, or an empty list to clear them.',
  },
  ISSUE_STATION_LANGUAGE_INVALID: {
    ar: 'لغة قائمة المحطات يجب أن تكون ar أو en.',
    en: 'The station language must be ar or en.',
  },
  ACTION_SET_STATION_LANGUAGE: {
    ar: 'حدد لغة قائمة المحطات بقيمة ar أو en.',
    en: 'Set the station language to ar or en.',
  },
  ISSUE_STATION_QUERY_TOO_LONG: {
    ar: 'عبارة البحث عن محطة يجب ألا تتجاوز {{maxLength}} حرفاً.',
    en: 'This station search must contain at most {{maxLength}} characters.',
  },
  ACTION_SHORTEN_STATION_QUERY: {
    ar: 'اختصر عبارة البحث عن محطة إلى {{maxLength}} حرفاً أو أقل.',
    en: 'Shorten the station search to {{maxLength}} characters or fewer.',
  },
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
    ar: 'هذا الوقت يجب أن يكون صالحاً من 00:00 إلى 23:59، على صورة HH:mm.',
    en: 'This time must be a valid time of day from 00:00 to 23:59, written as HH:mm.',
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
  ISSUE_IDEMPOTENCY_KEY_REUSED: {
    ar: 'مفتاح المعاملة هذا استُخدم بالفعل لطلب مختلف.',
    en: 'This idempotency key was already used for a different request.',
  },
  ISSUE_IDEMPOTENCY_KEY_REQUIRED: {
    ar: 'مفتاح المعاملة مطلوب لأي تغيير من المشغل.',
    en: 'An idempotency key is required for an operator change.',
  },
  ISSUE_FARE_NOT_POSITIVE_PIASTRES: {
    ar: 'الأجرة يجب أن تكون عدداً صحيحاً موجباً من القروش.',
    en: 'A fare must be a positive whole number of piastres.',
  },
  ISSUE_FARE_BELOW_PAYMENT_MINIMUM: {
    ar: 'هذه الأجرة أقل من الحد الأدنى الذي يمكن تحصيله.',
    en: 'This fare is below the minimum amount payment can process.',
  },
  ISSUE_NOT_AN_INSTANT: {
    ar: 'هذه ليست لحظة زمنية صالحة.',
    en: 'This is not a valid point in time.',
  },
  ISSUE_INSTANT_IN_THE_PAST: {
    ar: 'هذه اللحظة الزمنية قد مضت.',
    en: 'This point in time has already passed.',
  },
  ISSUE_TRAVEL_CLASS_NOT_KNOWN: {
    ar: 'درجة السفر هذه غير موجودة.',
    en: 'This travel class does not exist.',
  },
  ISSUE_TRAIN_HAS_NO_PUBLISHED_ROUTE: {
    ar: 'هذا القطار ليس له مسار منشور للتحقق من المحطتين.',
    en: 'This train has no published route to check the station pair against.',
  },
  ISSUE_TRAIN_DOES_NOT_RUN_PAIR_IN_ORDER: {
    ar: 'هذا القطار لا يزور هاتين المحطتين بهذا الترتيب.',
    en: 'This train does not visit these two stations in this travel order.',
  },
  ISSUE_CALLER_ACCOUNT_MISSING: {
    ar: 'وصل الطلب دون حساب مشغل.',
    en: 'The request arrived without an operator account.',
  },
  ISSUE_FARE_BELOW_CONTAINED_SEGMENT: {
    ar: 'هذه الأجرة أقل من أجرة الجزء الذي تتضمنه، وهي {{containedFarePiastres}} قرشاً.',
    en: 'This fare is below the {{containedFarePiastres}} piastres charged for a segment it contains.',
  },
  ISSUE_FARE_ALREADY_EFFECTIVE_AT_INSTANT: {
    ar: 'توجد أجرة لهذا القطار ودرجة السفر والمحطتين يبدأ سريانها في هذه اللحظة نفسها.',
    en: 'A fare for this train, travel class and station pair already takes effect at this exact instant.',
  },
  ACTION_SEND_NEW_IDEMPOTENCY_KEY: {
    ar: 'أرسل مفتاح معاملة جديداً لمحتوى طلب مختلف.',
    en: 'Send a new idempotency key for a different request body.',
  },
  ACTION_SEND_IDEMPOTENCY_KEY: {
    ar: 'أرسل مفتاح معاملة خاصاً بهذا الطلب.',
    en: 'Send an idempotency key unique to this request.',
  },
  ACTION_SEND_POSITIVE_PIASTRES: {
    ar: 'أرسل عدداً صحيحاً موجباً من القروش.',
    en: 'Send a positive whole number of piastres.',
  },
  ACTION_RAISE_FARE_TO_PAYMENT_MINIMUM: {
    ar: 'ارفع الأجرة إلى الحد الأدنى القابل للتحصيل أو أكثر.',
    en: 'Raise the fare to the minimum chargeable amount or more.',
  },
  ACTION_SEND_ISO_INSTANT: {
    ar: 'أرسل وقت البدء على صورة ISO-8601.',
    en: 'Send the effective time as an ISO-8601 instant.',
  },
  ACTION_PICK_INSTANT_NOW_OR_LATER: {
    ar: 'اختر وقتاً هو الآن أو بعده.',
    en: 'Choose a time that is now or later.',
  },
  ACTION_PICK_TRAIN_FROM_LIST: {
    ar: 'اختر رقم قطار من قائمة القطارات.',
    en: 'Choose a train number from the train list.',
  },
  ACTION_PICK_TRAVEL_CLASS_FROM_LIST: {
    ar: 'اختر درجة سفر من قائمة درجات السفر.',
    en: 'Choose a travel class from the travel class list.',
  },
  ACTION_PUBLISH_TIMETABLE_FIRST: {
    ar: 'انشر جدولاً زمنياً لهذا القطار قبل تغيير أجرته.',
    en: 'Publish a timetable for this train before changing its fares.',
  },
  ACTION_PICK_PAIR_IN_TRAVEL_ORDER: {
    ar: 'اختر محطتي مغادرة ووصول يزورهما القطار بهذا الترتيب.',
    en: 'Choose an origin and destination the train visits in that travel order.',
  },
  ACTION_SIGN_IN_AND_RETRY: {
    ar: 'سجّل الدخول مرة أخرى وأعد المحاولة.',
    en: 'Sign in again and retry the change.',
  },
  ACTION_RAISE_FARE_TO_CONTAINED_SEGMENT: {
    ar: 'ارفع هذه الأجرة إلى {{containedFarePiastres}} قرشاً على الأقل حتى لا تكون أقل من أجرة جزء تتضمنه.',
    en: 'Raise this fare to at least {{containedFarePiastres}} piastres so it is not cheaper than a segment it contains.',
  },
  ACTION_PICK_DIFFERENT_EFFECTIVE_INSTANT: {
    ar: 'اختر وقت بدء مختلفاً، ولو بفارق جزء من ألف من الثانية.',
    en: 'Choose a different effective time, even by one millisecond.',
  },
  ISSUE_ROUTE_NEEDS_TWO_STOPS: {
    ar: 'المسار يجب أن يضم محطتي توقف على الأقل.',
    en: 'A route must have at least two stops.',
  },
  ISSUE_STOP_POSITIONS_OUT_OF_ORDER: {
    ar: 'محطات التوقف ليست مرتبة بالترتيب الصحيح.',
    en: 'The stops are not in the correct order.',
  },
  ISSUE_DAY_OFFSET_GOES_BACKWARDS: {
    ar: 'فارق الأيام يعود إلى يوم سابق.',
    en: 'The day offset moves backwards.',
  },
  ISSUE_FIRST_STOP_HAS_ARRIVAL: {
    ar: 'المحطة الأولى لا يجب أن يكون لها وقت وصول.',
    en: 'The first stop must not have an arrival time.',
  },
  ISSUE_FIRST_STOP_LACKS_DEPARTURE: {
    ar: 'المحطة الأولى تحتاج إلى وقت مغادرة.',
    en: 'The first stop needs a departure time.',
  },
  ISSUE_LAST_STOP_HAS_DEPARTURE: {
    ar: 'المحطة الأخيرة لا يجب أن يكون لها وقت مغادرة.',
    en: 'The last stop must not have a departure time.',
  },
  ISSUE_LAST_STOP_LACKS_ARRIVAL: {
    ar: 'المحطة الأخيرة تحتاج إلى وقت وصول.',
    en: 'The last stop needs an arrival time.',
  },
  ISSUE_INTERMEDIATE_STOP_TIMES_INCOMPLETE: {
    ar: 'المحطة المتوسطة تحتاج إلى وقتي الوصول والمغادرة.',
    en: 'An intermediate stop needs both arrival and departure times.',
  },
  ISSUE_STOP_TIMES_INVALID: {
    ar: 'أوقات الجدول الزمني غير مكتملة أو غير صالحة.',
    en: 'The timetable times are incomplete or invalid.',
  },
  ISSUE_ORIGIN_STOP_LACKS_DEPARTURE: {
    ar: 'محطة المغادرة هذه ليس لها وقت مغادرة.',
    en: 'This origin stop has no departure time.',
  },
  ISSUE_DEPARTURE_BEFORE_ARRIVAL: {
    ar: 'وقت المغادرة يقع قبل وقت الوصول.',
    en: 'The departure time is before the arrival time.',
  },
  ISSUE_STOP_TIMES_OUT_OF_ORDER: {
    ar: 'أوقات محطات التوقف ليست مرتبة زمنياً.',
    en: 'The stop times are not in chronological order.',
  },
  ISSUE_TRAIN_HAS_NO_TRAVEL_CLASSES: {
    ar: 'هذا القطار ليس له درجات سفر.',
    en: 'This train has no travel classes.',
  },
  ISSUE_COACH_LAYOUT_NOT_KNOWN: {
    ar: 'تصميم العربة هذا غير موجود.',
    en: 'This coach layout does not exist.',
  },
  ISSUE_TRAIN_HAS_NO_SEATS: {
    ar: 'هذا القطار ليس له مقاعد.',
    en: 'This train has no seats.',
  },
  ISSUE_NO_RUNNING_DAYS: {
    ar: 'لم يُحدد أي يوم لتشغيل القطار.',
    en: 'No running day was specified for the train.',
  },
  ISSUE_WEEKDAY_OUT_OF_RANGE: {
    ar: 'هذا ليس يوم أسبوع من 0 للأحد إلى 6 للسبت.',
    en: 'This is not a weekday from 0 for Sunday through 6 for Saturday.',
  },
  ISSUE_STATION_REPEATED_ON_ROUTE: {
    ar: 'هذه المحطة موجودة بالفعل عند فهرس محطة التوقف {{firstStopIndex}}.',
    en: 'This station already appears at stop index {{firstStopIndex}}.',
  },
  ISSUE_FARE_MISSING_FOR_PAIR: {
    ar: 'لا توجد أجرة صالحة موجبة بعدد صحيح من القروش لدرجة السفر {{travelClassId}} من المحطة {{originStationId}} إلى المحطة {{destinationStationId}}.',
    en: 'A valid positive whole-number fare is missing for travel class {{travelClassId}} from station {{originStationId}} to station {{destinationStationId}}.',
  },
  ISSUE_FARE_BELOW_CONTAINED_SEGMENT_FOR_PAIR: {
    ar: 'لدرجة السفر {{travelClassId}}، أجرة الجزء من فهرس المحطة {{outerOriginIndex}} إلى {{outerDestinationIndex}} هي {{outerFarePiastres}} قرشاً، وهي أقل من أجرة الجزء الذي يتضمنه من فهرس المحطة {{innerOriginIndex}} إلى {{innerDestinationIndex}}، وقدرها {{innerFarePiastres}} قرشاً.',
    en: 'For travel class {{travelClassId}}, the {{outerFarePiastres}}-piastre fare from stop index {{outerOriginIndex}} to {{outerDestinationIndex}} is lower than the {{innerFarePiastres}}-piastre fare from stop index {{innerOriginIndex}} to {{innerDestinationIndex}}, which it contains.',
  },
  ISSUE_COACH_SEATS_REPEATED: {
    ar: 'العربة {{coachNumber}} تكرر أرقام المقاعد {{seatNumbers}}.',
    en: 'Coach {{coachNumber}} repeats seat numbers {{seatNumbers}}.',
  },
  ISSUE_EFFECTIVE_DATE_IN_THE_PAST: {
    ar: 'تاريخ البدء هذا قد مضى. تاريخ اليوم في القاهرة هو {{today}}.',
    en: 'This effective date is in the past. Today in Cairo is {{today}}.',
  },
  ISSUE_TRAIN_HAS_NO_COACHES: {
    ar: 'هذا القطار ليس له عربات حالياً.',
    en: 'This train currently has no coaches.',
  },
  ISSUE_COACH_COMPOSITION_MISMATCH: {
    ar: 'تركيبة العربات هذه لا تطابق القطار. يجب أن تتضمن العربة {{coachNumber}} في الموضع {{position}}، بدرجة السفر {{travelClassId}} وتصميم العربة {{coachLayoutId}}.',
    en: 'This composition does not match the train. It must include coach {{coachNumber}} at position {{position}}, with travel class {{travelClassId}} and layout {{coachLayoutId}}.',
  },
  ISSUE_SEAT_USAGE_UNAVAILABLE: {
    ar: 'تعذّر التحقق من المقاعد المباعة أو المحجوزة مؤقتاً في الرحلات المتأثرة.',
    en: 'Sold or held seats could not be checked for the affected trips.',
  },
  ISSUE_TRIP_SEAT_USAGE_UNAVAILABLE: {
    ar: 'تعذّر التحقق من المقاعد المباعة أو المحجوزة مؤقتاً للرحلة {{tripId}} في {{serviceDate}}.',
    en: 'Sold or held seats could not be checked for trip {{tripId}} on {{serviceDate}}.',
  },
  ISSUE_PUBLISH_WOULD_WITHDRAW_IN_USE_TRIP: {
    ar: 'في الرحلة {{tripId}} بتاريخ {{serviceDate}}، يبلغ عدد المقاعد المباعة {{soldCount}} وعدد المقاعد المحجوزة مؤقتاً {{heldCount}}. أيام التشغيل هذه ستلغي الرحلة.',
    en: 'For trip {{tripId}} on {{serviceDate}}, sold seats total {{soldCount}} and held seats total {{heldCount}}. These running days would withdraw the trip.',
  },
  ISSUE_PUBLISH_WOULD_DROP_IN_USE_STOPS: {
    ar: 'في الرحلة {{tripId}} بتاريخ {{serviceDate}}، يبلغ عدد المقاعد المباعة {{soldCount}} وعدد المقاعد المحجوزة مؤقتاً {{heldCount}}. يصعد الركاب أو ينزلون في المحطات {{stationIds}} التي سيزيلها هذا المسار.',
    en: 'For trip {{tripId}} on {{serviceDate}}, sold seats total {{soldCount}} and held seats total {{heldCount}}. Passengers board or alight at stations {{stationIds}}, which this route would remove.',
  },
  ISSUE_PUBLISH_WOULD_CHANGE_IN_USE_TRIP: {
    ar: 'في الرحلة {{tripId}} بتاريخ {{serviceDate}}، يبلغ عدد المقاعد المباعة {{soldCount}} وعدد المقاعد المحجوزة مؤقتاً {{heldCount}}. نشر هذا الجدول سيغيّر محطات الرحلة أو أوقاتها.',
    en: "For trip {{tripId}} on {{serviceDate}}, sold seats total {{soldCount}} and held seats total {{heldCount}}. This publish would change the trip's stops or times.",
  },
  ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_RANGE: {
    ar: 'تاريخ البدء هذا يتداخل مع نسخة منشورة من الجدول الزمني لهذا القطار.',
    en: 'This effective date overlaps a published timetable version for this train.',
  },
  ISSUE_TIMETABLE_OVERLAPS_PUBLISHED_VERSION: {
    ar: 'تاريخ البدء هذا يتداخل مع النسخة {{version}} من الجدول الزمني لهذا القطار، المنشورة من {{effectiveFrom}} إلى {{effectiveUntil}}.',
    en: 'This effective date overlaps timetable version {{version}} for this train, published from {{effectiveFrom}} to {{effectiveUntil}}.',
  },
  ISSUE_TIMETABLE_OVERLAPS_OPEN_ENDED_VERSION: {
    ar: 'تاريخ البدء هذا يتداخل مع النسخة {{version}} من الجدول الزمني لهذا القطار، المنشورة من {{effectiveFrom}} دون تاريخ انتهاء.',
    en: 'This effective date overlaps timetable version {{version}} for this train, published from {{effectiveFrom}} with no end date.',
  },
  ACTION_ADD_STOPS_TO_TWO: {
    ar: 'أضف محطات حتى يضم المسار محطتي توقف على الأقل.',
    en: 'Add stops until the route has at least two.',
  },
  ACTION_RENUMBER_STOP_POSITIONS: {
    ar: 'أعد ترقيم المحطات بترتيب متزايد.',
    en: 'Renumber the stop positions in increasing order.',
  },
  ACTION_FIX_DAY_OFFSET: {
    ar: 'زد فارق الأيام حتى لا يعود المسار إلى يوم سابق.',
    en: 'Increase the day offset so the route never moves backwards in calendar days.',
  },
  ACTION_CLEAR_ARRIVAL_ON_FIRST_STOP: {
    ar: 'امسح وقت الوصول في المحطة الأولى.',
    en: 'Clear the arrival time at the first stop.',
  },
  ACTION_SET_DEPARTURE_ON_FIRST_STOP: {
    ar: 'حدد وقت المغادرة في المحطة الأولى.',
    en: 'Set the departure time at the first stop.',
  },
  ACTION_CLEAR_DEPARTURE_ON_LAST_STOP: {
    ar: 'امسح وقت المغادرة في المحطة الأخيرة.',
    en: 'Clear the departure time at the last stop.',
  },
  ACTION_SET_ARRIVAL_ON_LAST_STOP: {
    ar: 'حدد وقت الوصول في المحطة الأخيرة.',
    en: 'Set the arrival time at the last stop.',
  },
  ACTION_SET_ARRIVAL_ON_STOP: {
    ar: 'حدد وقت الوصول في محطة التوقف هذه.',
    en: 'Set the arrival time at this stop.',
  },
  ACTION_SET_DEPARTURE_ON_STOP: {
    ar: 'حدد وقت المغادرة في محطة التوقف هذه.',
    en: 'Set the departure time at this stop.',
  },
  ACTION_SET_TIMES_ON_EVERY_INTERMEDIATE_STOP: {
    ar: 'حدد وقتي الوصول والمغادرة في كل محطة متوسطة.',
    en: 'Set arrival and departure times on every intermediate stop.',
  },
  ACTION_FIX_DEPARTURE_AFTER_ARRIVAL: {
    ar: 'حدد وقت مغادرة بعد الوصول أو مساوياً له.',
    en: 'Set the departure time at or after the arrival.',
  },
  ACTION_FIX_STOP_TIME_ORDER: {
    ar: 'حدد وقت وصول هذه المحطة بعد مغادرة المحطة السابقة أو عند وقتها نفسه.',
    en: "Set this stop's arrival at or after the previous stop's departure.",
  },
  ACTION_ADD_COACH_WITH_TRAVEL_CLASS: {
    ar: 'أضف عربة بدرجة سفر قبل النشر.',
    en: 'Add a coach with a travel class before publishing.',
  },
  ACTION_PICK_COACH_LAYOUT_FROM_LIST: {
    ar: 'اختر تصميم عربة موجوداً.',
    en: 'Choose an existing coach layout.',
  },
  ACTION_ADD_COACH_WITH_SEATS: {
    ar: 'أضف عربة بتصميم يحتوي على مقاعد قبل النشر.',
    en: 'Add a coach with a layout that contains seats before publishing.',
  },
  ACTION_LIST_RUNNING_WEEKDAYS: {
    ar: 'حدد يوم تشغيل واحداً على الأقل، من 0 للأحد إلى 6 للسبت.',
    en: 'List at least one running day, from 0 for Sunday through 6 for Saturday.',
  },
  ACTION_REMOVE_OR_FIX_WEEKDAY: {
    ar: 'احذف هذه القيمة أو استبدلها بيوم أسبوع من 0 إلى 6.',
    en: 'Remove this value or replace it with a weekday from 0 to 6.',
  },
  ACTION_SEND_EFFECTIVE_DATE: {
    ar: 'أرسل تاريخ البدء على صورة YYYY-MM-DD.',
    en: 'Send the effective date as YYYY-MM-DD.',
  },
  ACTION_REMOVE_REPEATED_STATION: {
    ar: 'احذف محطة التوقف المكررة، أو اختر محطة مختلفة.',
    en: 'Remove the repeated stop, or choose a different station.',
  },
  ACTION_ADD_FARE_FOR_PAIR: {
    ar: 'أضف أجرة صالحة موجبة بعدد صحيح من القروش لدرجة السفر {{travelClassId}} من المحطة {{originStationId}} إلى المحطة {{destinationStationId}}.',
    en: 'Add a valid positive whole-number fare for travel class {{travelClassId}} from station {{originStationId}} to station {{destinationStationId}}.',
  },
  ACTION_RAISE_FARE_FOR_PAIR: {
    ar: 'ارفع أجرة درجة السفر {{travelClassId}} من فهرس المحطة {{outerOriginIndex}} إلى {{outerDestinationIndex}} إلى {{innerFarePiastres}} قرشاً على الأقل.',
    en: 'Raise the fare for travel class {{travelClassId}} from stop index {{outerOriginIndex}} to {{outerDestinationIndex}} to at least {{innerFarePiastres}} piastres.',
  },
  ACTION_USE_UNIQUE_COACH_SEATS: {
    ar: 'استخدم كل رقم مقعد مرة واحدة فقط داخل العربة.',
    en: 'Use each seat number only once within a coach.',
  },
  ACTION_PICK_EFFECTIVE_DATE_NOW_OR_LATER: {
    ar: 'اختر تاريخ بدء هو {{today}} أو بعده.',
    en: 'Choose an effective date of {{today}} or later.',
  },
  ACTION_ADD_TRAIN_COACHES_BEFORE_PUBLISH: {
    ar: 'أضف عربات إلى القطار أولاً، ثم انشر الجدول الزمني.',
    en: 'Add coaches to the train first, then publish the timetable.',
  },
  ACTION_SEND_CURRENT_COACH_COMPOSITION: {
    ar: 'أرسل تركيبة العربات الحالية للقطار كما هي. لا يمكن تغييرها عبر هذا الطلب؛ غيّر عربات القطار أولاً، ثم انشر الجدول الزمني.',
    en: "Send exactly the train's current composition. This request cannot change it; change the train's coaches first, then publish.",
  },
  ACTION_RETRY_PUBLISH: {
    ar: 'أعد محاولة نشر الجدول الزمني بمفتاح المعاملة نفسه بعد نحو {{retryAfterSeconds}} ثانية.',
    en: 'Retry the publish with the same idempotency key in about {{retryAfterSeconds}} seconds.',
  },
  ACTION_KEEP_IN_USE_WEEKDAY_OR_PUBLISH_LATER: {
    ar: 'أبقِ يوم التشغيل هذا، أو أعد النشر بتاريخ بدء هو {{laterDate}} أو بعده.',
    en: 'Keep that weekday, or republish with an effective date of {{laterDate}} or later.',
  },
  ACTION_KEEP_IN_USE_STOPS_OR_PUBLISH_LATER: {
    ar: 'أبقِ محطات التوقف هذه، أو أعد النشر بتاريخ بدء هو {{laterDate}} أو بعده.',
    en: 'Keep those stops, or republish with an effective date of {{laterDate}} or later.',
  },
  ACTION_PUBLISH_AFTER_IN_USE_TRIPS: {
    ar: 'أعد النشر بتاريخ بدء هو {{laterDate}} أو بعده، حتى يقتصر التغيير على الرحلات التي لا تحتوي على مقاعد مباعة أو محجوزة مؤقتاً.',
    en: 'Republish with an effective date of {{laterDate}} or later, so the change reaches only trips with no sold or held seats.',
  },
  ACTION_PICK_NON_OVERLAPPING_DATES: {
    ar: 'اختر تاريخ بدء بعد النسخة المتداخلة، أو ألغِ تلك النسخة أولاً.',
    en: 'Choose an effective date after the clashing version, or withdraw that version first.',
  },
  ISSUE_FULL_NAME_INVALID: {
    ar: 'الاسم بالكامل يجب أن يحتوي على الاسم الأول واسم العائلة على الأقل بحروف عربية أو لاتينية، وبحد أقصى 50 حرفاً.',
    en: 'The full name must hold at least a first and a family name in Arabic or Latin letters, up to 50 characters.',
  },
  ACTION_SEND_FIRST_AND_FAMILY_NAME: {
    ar: 'أدخل الاسم الأول واسم العائلة على الأقل.',
    en: 'Enter at least a first and a family name.',
  },
  ISSUE_PHONE_NOT_EGYPTIAN_MOBILE: {
    ar: 'رقم الهاتف ليس رقم هاتف محمول مصرياً صحيحاً.',
    en: 'The phone number is not a valid Egyptian mobile number.',
  },
  ACTION_SEND_EGYPTIAN_MOBILE: {
    ar: 'أدخل رقم هاتف محمول مصرياً من 11 رقماً يبدأ بـ 010 أو 011 أو 012 أو 015.',
    en: 'Enter an 11-digit Egyptian mobile number starting with 010, 011, 012, or 015.',
  },
  ISSUE_NATIONAL_ID_LENGTH: {
    ar: 'الرقم القومي يجب أن يتكون من 14 رقماً بالضبط.',
    en: 'The National ID must be exactly 14 digits.',
  },
  ACTION_SEND_14_DIGIT_NATIONAL_ID: {
    ar: 'أدخل رقماً قومياً مصرياً من 14 رقماً.',
    en: 'Enter a 14-digit Egyptian National ID.',
  },
  ISSUE_NATIONAL_ID_CENTURY_DIGIT: {
    ar: 'رقم القرن في الرقم القومي يجب أن يكون 2 (القرن العشرين) أو 3 (القرن الحادي والعشرين).',
    en: 'The century digit of the National ID must be 2 (1900s) or 3 (2000s).',
  },
  ACTION_CHECK_NATIONAL_ID_CENTURY_DIGIT: {
    ar: 'راجع الرقم الأول في الرقم القومي.',
    en: 'Check the first digit of the National ID.',
  },
  ISSUE_NATIONAL_ID_BIRTH_DATE: {
    ar: 'تاريخ الميلاد في الرقم القومي ليس تاريخاً صحيحاً أو يقع في المستقبل.',
    en: 'The birth date in the National ID is not a valid date, or is in the future.',
  },
  ACTION_CHECK_NATIONAL_ID_BIRTH_DATE: {
    ar: 'راجع الأرقام من 2 إلى 7 (سنة وشهر ويوم الميلاد) في الرقم القومي.',
    en: 'Check digits 2 through 7 (YYMMDD) in the National ID.',
  },
  ISSUE_NATIONAL_ID_GOVERNORATE: {
    ar: 'كود المحافظة في الرقم القومي غير معروف.',
    en: 'The governorate code in the National ID is not recognized.',
  },
  ACTION_CHECK_NATIONAL_ID_GOVERNORATE: {
    ar: 'راجع الرقمين 8 و9 (كود المحافظة) في الرقم القومي.',
    en: 'Check digits 8 and 9 (the governorate code) in the National ID.',
  },
  ISSUE_NATIONAL_ID_INVALID: {
    ar: 'الرقم القومي غير صالح.',
    en: 'The National ID is invalid.',
  },
  ISSUE_PROFILE_TYPE_NOT_ACCEPTED: {
    ar: 'نوع الملف الشخصي غير مقبول.',
    en: 'The profile type is not an accepted one.',
  },
  ACTION_PICK_PROFILE_TYPE_FROM_OPTIONS: {
    ar: 'اختر نوع ملف شخصي من قائمة الخيارات.',
    en: 'Choose a profile type from the options list.',
  },
  ISSUE_NATIONALITY_NOT_ACCEPTED: {
    ar: 'الجنسية غير مقبولة.',
    en: 'The nationality is not an accepted one.',
  },
  ACTION_PICK_NATIONALITY_FROM_OPTIONS: {
    ar: 'اختر جنسية من قائمة الخيارات.',
    en: 'Choose a nationality from the options list.',
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
