// Outgoing e-mail.
//   • SMTP configured            → messages are sent with nodemailer.
//   • development / test, no SMTP → messages are kept in an in-memory outbox (and logged) so that
//                                   verification and password-reset links can be followed locally.
//   • production, no SMTP        → messages are dropped with a warning. Tokens are never logged.
//                                   Callers ask mailAvailable() first and say so instead.
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { escapeHtml } from '../lib/sanitize.js';

const OUTBOX_LIMIT = 100;
const outbox = [];
let transporter = null;

if (env.smtp) {
  transporter = nodemailer.createTransport(env.smtp);
}

export const mailConfigured = () => Boolean(transporter);

/**
 * Can a message reach its reader? Yes with SMTP; outside production the development mailbox
 * stands in for it. Where the answer is no, nothing that depends on e-mail is offered or
 * demanded: a reset link that never arrives, or a verification nobody can complete, would only
 * lock people out.
 */
let availability = null;
export const mailAvailable = () => availability ?? (Boolean(transporter) || !env.isProduction);
/** Tests only: `false` behaves like a production server without SMTP, `null` restores the default. */
export function setMailAvailable(value) {
  availability = value;
}

/** Development/test only: the most recent messages, newest first. */
export function devOutbox() {
  return [...outbox].reverse();
}

export function clearDevOutbox() {
  outbox.length = 0;
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2433">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e6e8f2">
    <div style="font-weight:700;font-size:18px;color:#4f46e5;margin-bottom:20px">EduSphere</div>
    <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
  <p style="font-size:12px;color:#7a8199;text-align:center;margin-top:16px">You received this message because of your EduSphere account.</p>
</div></body></html>`;
}

/**
 * @param {{ to: string, subject: string, text: string, title?: string, paragraphs?: string[],
 *           action?: { label: string, url: string } }} message
 */
export async function sendMail({ to, subject, text, title, paragraphs = [], action }) {
  const html = layout(
    title ?? subject,
    [
      ...paragraphs.map((p) => `<p style="line-height:1.6;margin:0 0 14px">${escapeHtml(p)}</p>`),
      action
        ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block;font-weight:600">${escapeHtml(action.label)}</a></p>
           <p style="font-size:12px;color:#7a8199;word-break:break-all">If the button does not work, open this link: ${escapeHtml(action.url)}</p>`
        : '',
    ].join('\n'),
  );
  const fullText = [text, action ? `\n${action.label}: ${action.url}` : ''].join('');

  if (transporter) {
    try {
      await transporter.sendMail({ from: env.mailFrom, to, subject, text: fullText, html });
      return { delivered: true };
    } catch (err) {
      logger.error({ err, to, subject }, 'e-mail delivery failed');
      return { delivered: false };
    }
  }
  if (!mailAvailable()) {
    logger.warn({ to, subject }, 'e-mail not sent: SMTP is not configured');
    return { delivered: false };
  }
  outbox.push({ to, subject, text: fullText, actionUrl: action?.url ?? null, sentAt: new Date().toISOString() });
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  logger.info({ to, subject, actionUrl: action?.url }, 'e-mail captured in the development outbox (SMTP not configured)');
  return { delivered: false, captured: true };
}
