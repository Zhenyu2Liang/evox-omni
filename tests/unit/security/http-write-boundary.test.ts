import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertSameOriginWrite, parseBody, parseOptionalBody, MAX_JSON_BODY_BYTES } from '@/app/api/_lib/http';

const schema = z.object({ message: z.string() });
afterEach(() => vi.unstubAllEnvs());
const request = (headers: Record<string, string> = {}, body = '{"message":"hello"}') => new Request('http://localhost/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});

it.each(['https://attacker.invalid', 'null', 'http://localhost.attacker.invalid'])('rejects foreign origin %s', async origin => {
  await expect(parseBody(schema, request({ origin }))).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
});
it('rejects cross-site writes without an Origin and protects bodyless DELETEs', () => {
  expect(() => assertSameOriginWrite(new Request('http://localhost/api/contacts/contact', {
    method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' },
  }))).toThrow('Cross-origin');
});
it('allows same-origin browser JSON and non-browser JSON clients', async () => {
  expect(await parseBody(schema, request({ origin: 'http://localhost' }))).toEqual({ message: 'hello' });
  expect(await parseBody(schema, request())).toEqual({ message: 'hello' });
});
it('does not trust a forwarded host to authorize a foreign origin', async () => {
  await expect(parseBody(schema, request({ origin: 'https://attacker.invalid', 'x-forwarded-host': 'attacker.invalid' })))
    .rejects.toMatchObject({ code: 'SECURITY_DENIED' });
});
it('accepts the browser Host when Next exposes an internal loopback hostname', async () => {
  expect(await parseBody(schema, request({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })))
    .toEqual({ message: 'hello' });
});
it.each(['attacker.test', 'localhost.attacker.test', '127.0.0.1.attacker.test', '2130706433'])('rejects a matching malicious Host and Origin: %s', async host => {
  await expect(parseBody(schema, request({ host, origin: `http://${host}` }))).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
});
it('requires an explicit trusted public origin and never accepts forwarded headers as configuration', async () => {
  vi.stubEnv('BANKING_ALLOWED_ORIGINS', 'https://bank.example:8443');
  expect(await parseBody(schema, request({ host: 'bank.example:8443', origin: 'https://bank.example:8443' })))
    .toEqual({ message: 'hello' });
  await expect(parseBody(schema, request({ host: 'evil.example', origin: 'https://evil.example', 'x-forwarded-host': 'bank.example:8443' })))
    .rejects.toMatchObject({ code: 'SECURITY_DENIED' });
});
it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])('rejects simple-request type %s', async type => {
  await expect(parseBody(schema, request({ 'content-type': type }))).rejects.toMatchObject({ code: 'VALIDATION' });
});
it('limits actual bytes even when Content-Length understates the body', async () => {
  await expect(parseBody(schema, request({ 'content-length': '1' }, JSON.stringify({ message: 'x'.repeat(MAX_JSON_BODY_BYTES) }))))
    .rejects.toMatchObject({ code: 'VALIDATION', message: 'Request body exceeds 64 KiB.' });
});
it('keeps empty optional JSON bodies working', async () => {
  expect(await parseOptionalBody(z.object({}), new Request('http://localhost/api/reset', { method: 'POST' }))).toEqual({});
});
