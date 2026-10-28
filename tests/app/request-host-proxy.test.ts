import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());
it.each(['/cards', '/overview', '/agent', '/api/cards', '/api/dashboard', '/api/health', '/_next/static/example.js'])
('rejects an untrusted Host on reads, including SSR pages and assets: %s', async pathname => {
  const request = new NextRequest(`http://localhost${pathname}`, { headers: { host: 'attacker.test', origin: 'http://attacker.test' } });
  const response = proxy(request);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SECURITY_DENIED' } });
});

it('accepts configured HTTPS proxy destinations but cannot add one through forwarded headers', () => {
  vi.stubEnv('BANKING_ALLOWED_ORIGINS', 'https://bank.example');
  expect(proxy(new NextRequest('http://127.0.0.1/cards', { headers: { host: 'bank.example' } })).headers.get('x-middleware-next')).toBe('1');
  expect(proxy(new NextRequest('http://127.0.0.1/cards', { headers: { host: 'other.example', 'x-forwarded-host': 'bank.example' } })).status).toBe(403);
});
