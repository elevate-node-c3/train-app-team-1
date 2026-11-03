const ARABIC_DIGITS: Record<string, string> = {
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

/**
 * Normalizes Eastern Arabic digits (٠–٩) to Western ASCII digits (0–9).
 */
export function normalizeDigits(input: string): string {
  return input.replace(/[٠-٩]/g, (digit) => ARABIC_DIGITS[digit] ?? digit);
}

