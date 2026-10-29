import type { VerificationCodePurpose } from '@app/contracts';

export interface VerificationEmailContent {
  subject: string;
  text: string;
  html: string;
}

interface VerificationEmailCopy {
  subject: string;
  text(code: string): string;
  html(code: string): string;
}

const EN_SIGN_UP: VerificationEmailCopy = {
  subject: 'Your Train verification code',
  text: (code) =>
    [
      `Your Train verification code is ${code}.`,
      '',
      'Enter it in the app to finish signing up. The code expires in 10 minutes.',
      'If you did not request this code, you can ignore this email.',
    ].join('\n'),
  html: (code) => `
    <div dir="ltr">
      <p>Your Train verification code is <strong dir="ltr">${escapeHtml(code)}</strong>.</p>
      <p>Enter it in the app to finish signing up. The code expires in 10 minutes.</p>
      <p>If you did not request this code, you can ignore this email.</p>
    </div>
  `,
};

const AR_SIGN_UP: VerificationEmailCopy = {
  subject: 'رمز التحقق الخاص بك في Train',
  text: (code) =>
    [
      `رمز التحقق الخاص بك في Train هو ${code}.`,
      '',
      'أدخله في التطبيق لإكمال التسجيل. تنتهي صلاحية الرمز خلال 10 دقائق.',
      'إذا لم تطلب هذا الرمز، يمكنك تجاهل هذه الرسالة.',
    ].join('\n'),
  html: (code) => `
    <div dir="rtl">
      <p>رمز التحقق الخاص بك في Train هو <strong dir="ltr">${escapeHtml(code)}</strong>.</p>
      <p>أدخله في التطبيق لإكمال التسجيل. تنتهي صلاحية الرمز خلال 10 دقائق.</p>
      <p>إذا لم تطلب هذا الرمز، يمكنك تجاهل هذه الرسالة.</p>
    </div>
  `,
};

const EN_RESET: VerificationEmailCopy = {
  subject: 'Reset your Train password',
  text: (code) =>
    [
      `Your Train password reset code is ${code}.`,
      '',
      'Enter it in the app to choose a new password. The code expires in 10 minutes.',
      'If you did not request a reset, you can ignore this email; your password has not changed.',
    ].join('\n'),
  html: (code) => `
    <div dir="ltr">
      <p>Your Train password reset code is <strong dir="ltr">${escapeHtml(code)}</strong>.</p>
      <p>Enter it in the app to choose a new password. The code expires in 10 minutes.</p>
      <p>If you did not request a reset, you can ignore this email; your password has not changed.</p>
    </div>
  `,
};

const AR_RESET: VerificationEmailCopy = {
  subject: 'إعادة تعيين كلمة المرور في Train',
  text: (code) =>
    [
      `رمز إعادة تعيين كلمة المرور في Train هو ${code}.`,
      '',
      'أدخله في التطبيق لاختيار كلمة مرور جديدة. تنتهي صلاحية الرمز خلال 10 دقائق.',
      'إذا لم تطلب إعادة التعيين، يمكنك تجاهل هذه الرسالة؛ لم تتغير كلمة المرور.',
    ].join('\n'),
  html: (code) => `
    <div dir="rtl">
      <p>رمز إعادة تعيين كلمة المرور في Train هو <strong dir="ltr">${escapeHtml(code)}</strong>.</p>
      <p>أدخله في التطبيق لاختيار كلمة مرور جديدة. تنتهي صلاحية الرمز خلال 10 دقائق.</p>
      <p>إذا لم تطلب إعادة التعيين، يمكنك تجاهل هذه الرسالة؛ لم تتغير كلمة المرور.</p>
    </div>
  `,
};

/**
 * BR-56: the account's stored language, not the request's Accept-Language.
 * Anything that is not English renders in Arabic, so an unsupported locale
 * still produces a usable email instead of failing delivery.
 *
 * The code appears in the body only. A subject line is visible in inbox
 * previews and in mail-server logs, which is not where a live secret belongs.
 * Reset copy is purpose-separated so a code mailed for one flow is not
 * presented as usable in the other.
 */
export function renderVerificationEmail(props: {
  code: string;
  language: string;
  purpose?: VerificationCodePurpose;
}): VerificationEmailContent {
  const arabic = props.language !== 'en';
  const reset = props.purpose === 'password_reset';
  const copy = reset
    ? arabic
      ? AR_RESET
      : EN_RESET
    : arabic
      ? AR_SIGN_UP
      : EN_SIGN_UP;
  return {
    subject: copy.subject,
    text: copy.text(props.code),
    html: copy.html(props.code),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
