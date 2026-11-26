import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { issuedTicket } from './testing/ticket-fixtures.js';
import { renderTicketPdf } from './ticket-pdf.js';

type TextCall = { text: string; x: number; options: { features?: unknown } };

/** Every string drawn, where, and how it was shaped. */
async function render(language: 'en' | 'ar'): Promise<{
  pdf: string;
  calls: TextCall[];
}> {
  const calls: TextCall[] = [];
  const original = PDFDocument.prototype.text;
  vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (
    this: PDFKit.PDFDocument,
    ...args: unknown[]
  ) {
    calls.push({
      text: String(args[0]),
      x: Number(args[1]),
      options: (args[3] ?? {}) as TextCall['options'],
    });
    return (original as (...rest: unknown[]) => PDFKit.PDFDocument).apply(
      this,
      args,
    );
  });
  const pdf = await renderTicketPdf(issuedTicket(), language);
  return { pdf: pdf.toString('latin1'), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderTicketPdf', () => {
  it.each(['en', 'ar'] as const)(
    'produces a %s PDF with the embedded font, the QR and its language',
    async (language) => {
      const { pdf } = await render(language);

      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+Tajawal-Bold/);
      expect(pdf).toMatch(/\/Subtype \/Image/);
      expect(pdf).toContain(`/Lang (${language})`);
    },
  );

  it('prints every field of the issued ticket', async () => {
    const { calls } = await render('en');
    const drawn = calls.map((call) => call.text).join('|');

    for (const expected of [
      'Train Ticket',
      'Ticket number: TKT-1',
      'El Raml Station — Ramsis Station',
      'Omar Khaled Hassan',
      'K7MQ2X',
      '916 · Express',
      'Second Class AC',
      'El Raml Station · 10 Jan, 2099 · 12:30 PM',
      'Ramsis Station · 10 Jan, 2099 · 04:00 PM',
      '3hr 30mins',
      '155.00 EGP',
      'Show this code to the conductor',
    ]) {
      expect(drawn).toContain(expected);
    }
  });

  it('shapes every Arabic run whole, so words keep their order and joins', async () => {
    const { calls } = await render('ar');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.options.features).toEqual([]);
    expect(calls.map((call) => call.text)).toContain('الدرجة الثانية مكيفة');
  });

  it('lays an Arabic ticket out right to left, and an English one left to right', async () => {
    const pageMiddle = 420 / 2;
    const english = await render('en');
    vi.restoreAllMocks();
    const arabic = await render('ar');

    const passengerLabel = (calls: TextCall[], label: string) =>
      calls.find((call) => call.text === label)!;

    expect(passengerLabel(english.calls, 'Passenger').x).toBeLessThan(
      pageMiddle,
    );
    expect(passengerLabel(arabic.calls, 'المسافر').x).toBeGreaterThan(
      pageMiddle,
    );
  });
});
