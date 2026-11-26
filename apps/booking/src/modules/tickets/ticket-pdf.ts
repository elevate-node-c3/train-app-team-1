import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { SupportedLanguage } from '@app/contracts';

import { visualRuns, type TextDirection } from './bidi-text.js';
import { ticketDocumentOf } from './ticket-document.js';
import type { IssuedTicket } from './ticket-view.js';

/**
 * Tajawal (SIL OFL 1.1, see assets/fonts/Tajawal-OFL.txt) carries Arabic and
 * Latin glyphs, so one embedded font prints both languages and any name. The
 * same relative path holds in source and in dist, where nest-cli copies it.
 */
const REGULAR_FONT = fileURLToPath(
  new URL('../../assets/fonts/Tajawal-Regular.ttf', import.meta.url),
);
const BOLD_FONT = fileURLToPath(
  new URL('../../assets/fonts/Tajawal-Bold.ttf', import.meta.url),
);

const MARGIN = 32;
const LABEL_WIDTH = 104;
const ROW_HEIGHT = 24;
const QR_SIZE = 150;
const MUTED = '#5f6b76';
const INK = '#14202b';

type Align = 'start' | 'end' | 'center';

/**
 * Without `features`, pdfkit shapes text one space-separated word at a time
 * and joins the words in logical order -- harmless for Latin, but it reverses
 * the word order of an Arabic phrase and moves its spaces. Any `features`
 * value makes it shape the whole run at once; fontkit still applies Arabic's
 * own features (init, medi, fina, rlig) on top of the empty list.
 */
const SHAPE_WHOLE_RUN = { features: [] as PDFKit.Mixins.OpenTypeFeatures[] };

/**
 * Booking's printed ticket (BR-38): the issued snapshot and its signed QR, in
 * the language the request asked for. An Arabic ticket is laid out right to
 * left -- labels on the right, text shaped by the font engine and ordered by
 * the bidi algorithm -- rather than an English ticket with reversed letters.
 */
export async function renderTicketPdf(
  ticket: IssuedTicket,
  language: SupportedLanguage,
): Promise<Buffer> {
  const model = ticketDocumentOf(ticket, language);
  const qrImage = await QRCode.toBuffer(model.qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 600,
  });

  const doc = new PDFDocument({
    size: 'A5',
    margin: MARGIN,
    lang: language,
    info: { Title: `${model.title} ${ticket.ticketNumber}` },
  });
  doc.registerFont('regular', REGULAR_FONT);
  doc.registerFont('bold', BOLD_FONT);

  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const line = (
    text: string,
    y: number,
    options: {
      font: 'regular' | 'bold';
      size: number;
      align: Align;
      x?: number;
      width?: number;
      color?: string;
    },
  ): void =>
    drawLine(doc, text, model.direction, {
      x: options.x ?? MARGIN,
      y,
      width: options.width ?? width,
      ...options,
    });

  line(model.title, MARGIN, { font: 'bold', size: 20, align: 'start' });
  line(model.ticketNumber, MARGIN + 6, {
    font: 'regular',
    size: 10,
    align: 'end',
    color: MUTED,
  });
  line(model.route, MARGIN + 38, { font: 'bold', size: 15, align: 'start' });

  const ruleY = MARGIN + 66;
  doc
    .moveTo(MARGIN, ruleY)
    .lineTo(MARGIN + width, ruleY)
    .lineWidth(0.6)
    .strokeColor('#c8d0d7')
    .stroke();

  // Labels sit on the reading side: left for English, right for Arabic.
  const rtl = model.direction === 'rtl';
  const labelX = rtl ? MARGIN + width - LABEL_WIDTH : MARGIN;
  const valueX = rtl ? MARGIN : MARGIN + LABEL_WIDTH;
  const valueWidth = width - LABEL_WIDTH;
  model.rows.forEach((row, index) => {
    const y = ruleY + 14 + index * ROW_HEIGHT;
    line(row.label, y + 1, {
      font: 'regular',
      size: 10,
      align: 'start',
      x: labelX,
      width: LABEL_WIDTH,
      color: MUTED,
    });
    line(row.value, y, {
      font: 'bold',
      size: 11.5,
      align: 'start',
      x: valueX,
      width: valueWidth,
    });
  });

  const qrY = ruleY + 14 + model.rows.length * ROW_HEIGHT + 8;
  doc.image(qrImage, MARGIN + (width - QR_SIZE) / 2, qrY, {
    width: QR_SIZE,
    height: QR_SIZE,
  });
  line(model.qrCaption, qrY + QR_SIZE + 6, {
    font: 'regular',
    size: 10,
    align: 'center',
    color: MUTED,
  });

  doc.end();
  return finished;
}

/**
 * One line of text, drawn run by run in visual order so mixed Arabic and
 * digits read correctly. A value too wide for its column is shrunk to fit
 * rather than wrapped, which a ticket row has no room for.
 */
function drawLine(
  doc: PDFKit.PDFDocument,
  text: string,
  direction: TextDirection,
  options: {
    x: number;
    y: number;
    width: number;
    font: 'regular' | 'bold';
    size: number;
    align: Align;
    color?: string;
  },
): void {
  const runs = visualRuns(text, direction);
  let size = options.size;
  doc.font(options.font);
  const measure = (): number[] => {
    doc.fontSize(size);
    return runs.map((run) => doc.widthOfString(run.text, SHAPE_WHOLE_RUN));
  };
  let widths = measure();
  while (sum(widths) > options.width && size > 7) {
    size -= 0.5;
    widths = measure();
  }

  // 'start' is the reading side: left for English, right for Arabic.
  const align =
    options.align === 'center'
      ? 'center'
      : (options.align === 'start') === (direction === 'ltr')
        ? 'left'
        : 'right';
  const total = sum(widths);
  let x =
    align === 'left'
      ? options.x
      : align === 'right'
        ? options.x + options.width - total
        : options.x + (options.width - total) / 2;

  doc.fillColor(options.color ?? INK);
  runs.forEach((run, index) => {
    doc.text(run.text, x, options.y, { lineBreak: false, ...SHAPE_WHOLE_RUN });
    x += widths[index];
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
