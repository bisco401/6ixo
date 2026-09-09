import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const handlerSource = readFileSync(new URL('../supabase/functions/send-contact-message/handler.ts', import.meta.url), 'utf8');
const context = vm.createContext({ Request, Response, Headers, TextEncoder, TextDecoder, AbortSignal, crypto: webcrypto, fetch });
vm.runInContext(stripTypeScriptTypes(handlerSource.replace('export function createContactHandler', 'function createContactHandler'), { mode: 'transform' }) + '\nglobalThis.createHandler = createContactHandler;', context);
const config = { supabaseUrl: 'https://backend.example.test', serviceRoleKey: 'private-service-key', resendApiKey: 'private-email-key', sender: '6ixo <noreply@6ixo.com>' };
const valid = { name: 'Test Visitor', email: 'visitor@example.test', subject: 'Rental question', message: 'How do I list my rental car?', website: '', requestId: 'dbf616cf-17dc-4089-8e56-4f70f21b2c87' };
const request = (payload = valid, options = {}) => new Request('https://backend.example.test/functions/v1/send-contact-message', {
  method: 'POST', headers: { Origin: 'https://6ixo.com', 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.12' }, body: JSON.stringify(payload), ...options,
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
function server(overrides = {}) {
  const calls = [];
  const handle = context.createHandler({ ...config, ...overrides.config }, async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    if (url.includes('/rpc/')) return overrides.quota?.() ?? json([{ allowed: true }]);
    return overrides.email?.() ?? json({ id: 'mail-accepted' });
  });
  return { handle, calls };
}

test('valid guest contact goes only to support, with reply-to and no plaintext quota identifiers', async () => {
  const s = server(); const response = await s.handle(request({ ...valid, to: 'attacker@example.test' }));
  assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0].payload.p_ip_hash, /^[a-f0-9]{64}$/);
  assert.match(s.calls[0].payload.p_email_hash, /^[a-f0-9]{64}$/);
  assert.ok(!s.calls[0].body.includes(valid.email));
  assert.deepEqual(s.calls[1].payload.to, ['contact@6ixo.com']);
  assert.equal(s.calls[1].payload.reply_to, valid.email);
  assert.equal(s.calls[1].payload.from, config.sender);
  assert.ok(s.calls[1].payload.text.includes(valid.message));
  assert.equal(s.calls[1].payload.html, undefined);
});

test('validation and honeypot failures never consume quota or send mail', async () => {
  for (const payload of [{ ...valid, email: 'bad' }, { ...valid, subject: 'Subject\r\nBcc: other@example.test' }, { ...valid, name: '' }, { ...valid, message: 'x'.repeat(5001) }, { ...valid, requestId: 'bad' }, { ...valid, website: 'spam.test' }, null, []]) {
    const s = server(); assert.equal((await s.handle(request(payload))).status, 400); assert.equal(s.calls.length, 0);
  }
});

test('unsupported origins, methods and oversized bodies cannot send mail; site preflight succeeds', async () => {
  const s = server();
  assert.equal((await s.handle(request(valid, { headers: { Origin: 'https://unrelated.test' } }))).status, 403);
  assert.equal((await s.handle(new Request('https://backend.example.test', { headers: { Origin: 'https://6ixo.com' } }))).status, 405);
  assert.equal((await s.handle(request(valid, { body: 'x'.repeat(24001) }))).status, 413);
  const preflight = await s.handle(new Request('https://backend.example.test', { method: 'OPTIONS', headers: { Origin: 'https://6ixo.com' } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://6ixo.com');
  assert.equal(s.calls.length, 0);
});

test('quota denial and backend failure stop before the email provider', async () => {
  for (const [quota, expected] of [[() => json([{ allowed: false, retry_after_seconds: 42 }]), 429], [() => json({ error: 'database failed' }, 500), 503]]) {
    const s = server({ quota }); const response = await s.handle(request());
    assert.equal(response.status, expected); assert.equal(s.calls.length, 1);
    if (expected === 429) assert.equal(response.headers.get('Retry-After'), '42');
  }
});

test('provider rejection, malformed success and missing configuration never report success or leak details', async () => {
  for (const email of [() => json({ error: config.resendApiKey }, 403), () => json({}), () => { throw new Error(config.resendApiKey); }]) {
    const s = server({ email }); const response = await s.handle(request()); const body = await response.json();
    assert.ok(response.status >= 500); assert.equal(body.accepted, false); assert.ok(!JSON.stringify(body).includes(config.resendApiKey));
  }
  const s = server({ config: { resendApiKey: '' } }); assert.equal((await s.handle(request())).status, 503); assert.equal(s.calls.length, 0);
});

test('a retry reuses the provider idempotency key, but changed message content gets a different key', async () => {
  const s = server(); await s.handle(request()); await s.handle(request()); await s.handle(request({ ...valid, message: 'Updated rental question' }));
  const keys = s.calls.filter(x => x.url.includes('resend.com')).map(x => x.headers['Idempotency-Key']);
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
});

const appSource = readFileSync(process.env.AUDIT_APP_SOURCE || new URL('../app.js', import.meta.url), 'utf8');
const methodStart = appSource.indexOf('    async handleContactSubmit(event) {');
const methodEnd = appSource.indexOf('// Home (Kijiji-style) functionality', methodStart);
assert.ok(methodStart > 0 && methodEnd > methodStart);
function clientFixture(send) {
  const status = { textContent: '', dataset: {} }; const button = { textContent: 'Send Message', disabled: false };
  const fields = { ...valid }; let resetCount = 0;
  const control = { disabled: false };
  const form = { elements: [control, button], reportValidity: () => true, querySelector: selector => selector === '#contact-status' ? status : button, reset() { resetCount++; }, setAttribute() {}, removeAttribute() {} };
  const c = { window: { SUPABASE_URL: config.supabaseUrl }, crypto: webcrypto, AbortController, setTimeout, clearTimeout, fetch: send, FormData: class { get(key) { return fields[key]; } } };
  vm.runInNewContext(`class App {${appSource.slice(methodStart, methodEnd)} }\nglobalThis.app = new App();`, c);
  return { app: c.app, form, fields, status, button, control, get resetCount() { return resetCount; }, event: { currentTarget: form, preventDefault() {} } };
}

test('client ignores double submission, disables controls while pending and resets only after acceptance', async () => {
  let release; let calls = 0; const pending = new Promise(resolve => { release = resolve; });
  const f = clientFixture(async () => { calls++; await pending; return json({ accepted: true }); });
  const first = f.app.handleContactSubmit(f.event); await f.app.handleContactSubmit(f.event);
  assert.equal(calls, 1); assert.equal(f.button.disabled, true); assert.equal(f.control.disabled, true); assert.equal(f.resetCount, 0);
  release(); await first;
  assert.equal(f.resetCount, 1); assert.equal(f.status.dataset.state, 'success'); assert.equal(f.button.disabled, false); assert.equal(f.app.contactFormBusy, false);
});

test('failed client submission preserves the draft and retry id; editing creates a new id', async () => {
  const sent = []; const f = clientFixture(async (_, options) => { sent.push(JSON.parse(options.body)); return json({ accepted: false, error: 'Please try later.' }, 503); });
  await f.app.handleContactSubmit(f.event); await f.app.handleContactSubmit(f.event);
  assert.equal(f.resetCount, 0); assert.equal(f.fields.message, valid.message); assert.equal(f.status.textContent, 'Please try later.');
  assert.equal(sent[0].requestId, sent[1].requestId); assert.equal(f.button.disabled, false);
  f.fields.message = 'A changed question'; await f.app.handleContactSubmit(f.event); assert.notEqual(sent[1].requestId, sent[2].requestId);
});

test('network failure and an unconfirmed 200 response keep the draft and restore the form', async () => {
  for (const send of [async () => { throw new TypeError('Failed to fetch'); }, async () => json({})]) {
    const f = clientFixture(send); await f.app.handleContactSubmit(f.event);
    assert.equal(f.resetCount, 0); assert.equal(f.status.dataset.state, 'error'); assert.equal(f.button.disabled, false); assert.equal(f.app.contactFormBusy, false);
  }
});
