import type { Config } from './config.js';

/**
 * Sending mail, behind one small interface so another provider can be added beside Resend.
 * With no key set there is no mailer, and the app behaves as it always did: the owner passes links on by hand.
 * send() never throws. A message that could not be sent comes back as { ok: false, error } with a sentence
 * the owner can act on, because an invite must never fail just because its email did.
 */
export interface MailMessage { to: string; subject: string; text: string; html: string }
export type MailResult = { ok: true; id: string | null } | { ok: false; error: string };
export interface Mailer {
  readonly enabled: boolean;
  /** The address mail is sent from, as the owner wrote it. */
  readonly from: string | null;
  send(msg: MailMessage): Promise<MailResult>;
}

const off: Mailer = { enabled: false, from: null, send: async () => ({ ok: false, error: 'This server is not set up to send email.' }) };

export function createMailer(cfg: Config, fetchImpl: typeof fetch = fetch): Mailer {
  if (!cfg.RESEND_API_KEY) return off;
  return resendMailer(cfg, fetchImpl);
}

/**
 * Resend's REST API (https://resend.com/docs/api-reference/emails/send-email):
 * POST https://api.resend.com/emails with a Bearer key and a JSON body of from, to, subject, html, text, reply_to.
 * A User-Agent is required. Without one Resend answers 403. Success is { id }. A failure is a 4xx or 5xx
 * whose body carries a message. The key goes in one header and nowhere else: never in a log, never in an error.
 */
function resendMailer(cfg: Config, fetchImpl: typeof fetch): Mailer {
  return {
    enabled: true,
    from: cfg.MAIL_FROM,
    async send(msg) {
      let res: Response;
      try {
        res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'content-type': 'application/json', 'user-agent': 'afterimage-server/1' },
          body: JSON.stringify({ from: cfg.MAIL_FROM, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(cfg.MAIL_REPLY_TO ? { reply_to: cfg.MAIL_REPLY_TO } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e: any) {
        return { ok: false, error: e?.name === 'TimeoutError' ? 'Resend did not answer in time. Try again in a moment.' : 'Resend could not be reached. Check the server\'s connection to the internet.' };
      }
      let body: any = null;
      try { body = await res.json(); } catch { /* not JSON: the status has to do */ }
      if (res.ok) return { ok: true, id: typeof body?.id === 'string' ? body.id : null };
      const said = typeof body?.message === 'string' && body.message.trim() ? body.message.trim().replace(/\.$/, '') : '';
      if (res.status === 401 || (res.status === 403 && /api key/i.test(said))) return { ok: false, error: 'Resend did not accept the API key. Check RESEND_API_KEY in the server settings.' };
      if (res.status === 429) return { ok: false, error: 'Resend is receiving too many messages from this server right now. Try again in a moment.' };
      if (res.status >= 500) return { ok: false, error: 'Resend had a problem of its own. Try again in a moment.' };
      // 400, 403, 422: Resend says what is wrong, for example a sending domain that is not verified yet.
      return { ok: false, error: said ? `Resend refused the message: ${said}.` : `Resend refused the message (status ${res.status}).` };
    },
  };
}

/* ---------- the two messages this app sends ---------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ROLE_WORDS: Record<string, string> = {
  editor: 'As an editor you can add photos, tag them, edit copies, comment and download.',
  commenter: 'You can look at everything shared with you, comment and download.',
  viewer: 'You can look at everything shared with you.',
  owner: 'As an owner you can do everything, including people and settings.',
};
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** Plain and short: the mark, what this is, one button, and how long the link lasts. No tracking, no footer. */
function page(cfg: Config, o: { heading: string; lines: string[]; button: string; link: string; after: string }) {
  const p = (t: string) => `<p style="margin:0 0 14px;font:16px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1d1f">${esc(t)}</p>`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#eeede9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eeede9"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #d0cec7"><tr><td style="padding:28px 28px 24px">
<img src="${esc(cfg.PUBLIC_URL)}/assets/app-icon.png" width="44" height="44" alt="ImageStoria" style="display:block;border:0;margin:0 0 18px">
<h1 style="margin:0 0 14px;font:600 22px/1.25 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1d1f">${esc(o.heading)}</h1>
${o.lines.map(p).join('\n')}
<p style="margin:22px 0"><a href="${esc(o.link)}" style="display:inline-block;background:#ffb224;color:#1f1600;font:600 16px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;text-decoration:none;padding:12px 22px;border-radius:8px">${esc(o.button)}</a></p>
<p style="margin:0 0 10px;font:14px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#5f6369">${esc(o.after)}</p>
<p style="margin:0;font:13px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#5f6369;word-break:break-all">If the button does not work, copy this address into your browser:<br>${esc(o.link)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [o.heading, '', ...o.lines, '', `${o.button}: ${o.link}`, '', o.after].join('\n');
  return { html, text };
}

export function inviteMail(cfg: Config, o: { to: string; link: string; inviter: string; role: string; validDays: number }): MailMessage {
  const role = o.role === 'editor' ? 'an editor' : `a ${o.role}`;
  return {
    to: o.to, subject: `${o.inviter} invited you to their ImageStoria library`,
    ...page(cfg, {
      heading: 'You are invited',
      lines: [`${o.inviter} added you to a private photo library on ImageStoria, as ${role}.`, ROLE_WORDS[o.role] ?? ''].filter(Boolean),
      button: 'Join the library', link: o.link,
      after: `This link works once, for ${days(o.validDays)}. If you were not expecting it, you can ignore this message.`,
    }),
  };
}

export function resetMail(cfg: Config, o: { to: string; link: string; name: string; validDays: number }): MailMessage {
  return {
    to: o.to, subject: 'Choose a new password for ImageStoria',
    ...page(cfg, {
      heading: 'Choose a new password',
      lines: [`Hello ${o.name}. The owner of your ImageStoria library sent you this link so you can choose a new password.`],
      button: 'Choose a new password', link: o.link,
      after: `This link works once, for ${days(o.validDays)}. If you did not ask for it, you can ignore this message and your password stays as it is.`,
    }),
  };
}

export function testMail(cfg: Config, to: string): MailMessage {
  return {
    to, subject: 'ImageStoria can send email',
    ...page(cfg, {
      heading: 'Email is working',
      lines: [`This is a test message from the ImageStoria server at ${cfg.PUBLIC_URL}. If you are reading it, invites and password reset links will arrive the same way.`],
      button: 'Open ImageStoria', link: cfg.PUBLIC_URL,
      after: 'Nothing else needs doing.',
    }),
  };
}
