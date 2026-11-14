import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/server/config.js';
import { createMailer } from '../src/server/mail.js';
import { Client, startApp } from './helpers.js';

const KEY = 're_test_key_that_must_never_leak';
type Sent = { url: string; headers: Record<string, string>; body: any };

/** Stands in for Resend's HTTP API: remembers what it was sent and answers as told. No real request leaves the machine. */
function fakeResend() {
  const sent: Sent[] = [];
  const state = { answer: (): Response | Promise<Response> => Response.json({ id: 'msg-1' }) };
  const fetchImpl = (async (url: any, init: any) => { sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return state.answer(); }) as typeof fetch;
  return { sent, state, fetchImpl };
}

describe('email', () => {
  describe('with no key set', () => {
    let app: Awaited<ReturnType<typeof startApp>>, owner: Client;
    before(async () => { app = await startApp('ai_test_mail_off'); owner = new Client(app.base); await owner.post('/api/setup', { name: 'Chaz', email: 'chaz@example.com', password: 'correct horse battery' }); });
    after(async () => { await app.stop(); });

    it('sends nothing and behaves as it always did', async () => {
      assert.equal(app.ctx.mail.enabled, false);
      const real = globalThis.fetch; let outside = 0;
      globalThis.fetch = ((...a: Parameters<typeof fetch>) => { if (String(a[0]).includes('resend')) outside++; return real(...a); }) as typeof fetch;
      try {
        const inv = await owner.post('/api/people/invite', { who: 'maria@example.com', role: 'viewer', spaceIds: [] });
        assert.equal(inv.status, 200); assert.match(inv.data.link, /\/\?invite=[\w-]{20,}$/); assert.equal(inv.data.mail, null);
        assert.equal((await owner.post(`/api/people/${inv.data.id}/link`)).data.mail, null);
      } finally { globalThis.fetch = real; }
      assert.equal(outside, 0);
      assert.deepEqual((await owner.get('/api/admin/overview')).data.mail, { on: false, from: null });
    });
  });

  describe('with a Resend key', () => {
    let app: Awaited<ReturnType<typeof startApp>>, owner: Client, resend: ReturnType<typeof fakeResend>;
    before(async () => {
      app = await startApp('ai_test_mail_on', { RESEND_API_KEY: KEY, MAIL_FROM: 'ImageStoria <photos@example.com>', MAIL_REPLY_TO: 'chaz@example.com' });
      resend = fakeResend(); app.ctx.mail = createMailer(app.cfg, resend.fetchImpl);
      owner = new Client(app.base); await owner.post('/api/setup', { name: 'Chaz <Owner>', email: 'chaz@example.com', password: 'correct horse battery' });
    });
    after(async () => { await app.stop(); });

    it('needs to know who the mail comes from', () => {
      assert.throws(() => loadConfig({ RESEND_API_KEY: KEY }), /MAIL_FROM/);
      assert.throws(() => loadConfig({ RESEND_API_KEY: KEY, MAIL_FROM: 'ImageStoria' }), /MAIL_FROM/);
      assert.equal(loadConfig({ RESEND_API_KEY: KEY, MAIL_FROM: 'photos@example.com' }).MAIL_FROM, 'photos@example.com');
    });

    it('emails an invite, and still hands back the link', async () => {
      const inv = await owner.post('/api/people/invite', { who: 'Maria@Example.com', role: 'editor', spaceIds: [] });
      assert.equal(inv.status, 200);
      assert.deepEqual(inv.data.mail, { sent: true, to: 'maria@example.com' });
      assert.equal(resend.sent.length, 1);
      const m = resend.sent[0]!;
      assert.equal(m.url, 'https://api.resend.com/emails');
      assert.equal(m.headers.authorization, `Bearer ${KEY}`);
      assert.ok(m.headers['user-agent'], 'Resend refuses requests that carry no User-Agent');
      assert.deepEqual([m.body.from, m.body.to, m.body.reply_to], ['ImageStoria <photos@example.com>', ['maria@example.com'], 'chaz@example.com']);
      assert.match(m.body.subject, /invited you/);
      // a text part and an HTML part, each with the link, the inviter, the role in words and how long the link lasts
      for (const part of [m.body.text, m.body.html] as string[]) {
        assert.ok(part.includes(inv.data.link), 'the link');
        assert.match(part, /as an editor/); assert.match(part, /add photos, tag them, edit copies, comment and download/);
        assert.match(part, /works once, for 14 days/);
      }
      assert.ok(m.body.text.includes('Chaz <Owner> added you'));
      assert.ok(m.body.html.includes('Chaz &lt;Owner&gt; added you') && !m.body.html.includes('<Owner>'), 'names are escaped in the HTML part');
      assert.equal((m.body.html.match(/<img /g) ?? []).length, 1, 'one picture, the mark, and no tracking pixel');
      assert.match(m.body.html, /<img src="http:\/\/127\.0\.0\.1:\d+\/assets\/app-icon\.png"[^>]* alt="ImageStoria"/);
      assert.equal((m.body.html.match(/<a /g) ?? []).length, 1, 'one button');
      assert.ok(!/unsubscribe|utm_/i.test(m.body.html), 'no marketing footer');
      assert.deepEqual((await owner.get('/api/admin/overview')).data.mail, { on: true, from: 'ImageStoria <photos@example.com>' });
    });

    it('does not email an invite by handle, which has no address', async () => {
      const n = resend.sent.length;
      const inv = await owner.post('/api/people/invite', { who: '@lupita', role: 'viewer', spaceIds: [] });
      assert.equal(inv.status, 200); assert.equal(inv.data.mail, null); assert.ok(inv.data.link);
      assert.equal(resend.sent.length, n);
    });

    it('emails a password reset link to someone who has joined, and a fresh invite to someone who has not', async () => {
      const people = (await owner.get('/api/people')).data.people;
      const maria = people.find((p: any) => p.email === 'maria@example.com'), me = people.find((p: any) => p.role === 'owner');
      const again = await owner.post(`/api/people/${maria.id}/link`);
      assert.deepEqual([again.data.kind, again.data.mail], ['invite', { sent: true, to: 'maria@example.com' }]);
      const reset = await owner.post(`/api/people/${me.id}/link`);
      assert.deepEqual([reset.data.kind, reset.data.mail], ['reset', { sent: true, to: 'chaz@example.com' }]);
      const m = resend.sent.at(-1)!;
      assert.match(m.body.subject, /new password/); assert.ok(m.body.text.includes(reset.data.link) && /\?reset=/.test(reset.data.link));
      assert.match(m.body.text, /works once, for 2 days/);
    });

    it('never fails an invite because the email failed, and says why in words', async () => {
      const cases: [() => Response | Promise<Response>, RegExp][] = [
        [() => Response.json({ statusCode: 403, name: 'validation_error', message: 'The example.com domain is not verified. Please, add and verify your domain.' }, { status: 403 }), /^Resend refused the message: The example\.com domain is not verified\. Please, add and verify your domain\.$/],
        [() => Response.json({ statusCode: 401, name: 'validation_error', message: 'API key is invalid' }, { status: 401 }), /did not accept the API key/],
        [() => Response.json({ name: 'rate_limit_exceeded', message: 'Too many requests' }, { status: 429 }), /Try again in a moment/],
        [() => new Response('bad gateway', { status: 502 }), /problem of its own/],
        [() => Promise.reject(new TypeError('fetch failed')), /could not be reached/],
      ];
      for (const [k, [answer, says]] of cases.entries()) {
        resend.state.answer = answer;
        const inv = await owner.post('/api/people/invite', { who: `fail${k}@example.com`, role: 'viewer', spaceIds: [] });
        assert.equal(inv.status, 200, 'the invite is made all the same');
        assert.match(inv.data.link, /\?invite=/);
        assert.equal(inv.data.mail.sent, false); assert.match(inv.data.mail.error, says);
        assert.ok(!JSON.stringify(inv.data).includes(KEY), 'the key is never sent to the page');
      }
      resend.state.answer = () => Response.json({ id: 'msg-2' });
      assert.equal((await owner.get('/api/people')).data.people.filter((p: any) => /^fail\d@/.test(p.email)).length, cases.length);
    });

    it('keeps the key out of everything the page can read', async () => {
      for (const url of ['/api/bootstrap', '/api/admin/overview', '/api/people']) assert.ok(!JSON.stringify((await owner.get(url)).data).includes(KEY), url);
    });
  });
});
