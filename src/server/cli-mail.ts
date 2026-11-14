/**
 * Send one real test message, to check the Resend key and the sending domain.
 *
 *   npm run mail:test -- you@example.com
 *   docker compose exec app npm run mail:test -- you@example.com
 */
import { loadConfig } from './config.js';
import { createMailer, testMail } from './mail.js';

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('Give the address to send to. For example: npm run mail:test -- you@example.com');
  process.exit(2);
}
const cfg = loadConfig();
const mailer = createMailer(cfg);
if (!mailer.enabled) {
  console.error('Email is off. Set RESEND_API_KEY and MAIL_FROM in the settings, then try again.');
  process.exit(2);
}
console.log(`Sending a test message from ${mailer.from} to ${to}`);
const r = await mailer.send(testMail(cfg, to));
if (r.ok) console.log(`Sent. Resend accepted it${r.id ? ` as ${r.id}` : ''}. Check the inbox, and the spam folder if it is not there.`);
else console.error(`Not sent. ${r.error}`);
process.exit(r.ok ? 0 : 1);
