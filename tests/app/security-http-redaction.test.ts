/**
 * tests/app/security-http-redaction.test.ts — PUBLIC projection of `GET /api/security`.
 *
 * SECURITY / PRIVACY regression for the security-center read model. The endpoint used to serialize
 * `audit.listSecurityEvents({ sessionId })` VERBATIM, so a `SecurityEvent` whose `message` carried
 * the gateway's `__SECURITY_BLOCK__{"decisionKind":"deny"}` marker, a raw stack trace, or a
 * JSON-fragment `detail` would reach the browser through the JSON body.
 *
 * What MUST hold at the HTTP boundary:
 *  - the RAW response text never contains an internal diagnostic (`__SECURITY_BLOCK__`,
 *    `decisionKind`, `Error:`, `at Object.`, `"undefined"`);
 *  - the STRUCTURED facts are preserved and unweakened (`ok`, per-event `kind`/`severity`/
 *    `timestamp`/`sessionId`, `circuitBreaker`, `lock.code`, `lockedActions`);
 *  - legitimate audit PROSE is kept VERBATIM — the projection is NOT an over-sanitizer that
 *    replaces real business descriptions with a fallback sentence;
 *  - a `detail` carrying an internal diagnostic is dropped, while a genuinely safe `detail` (the
 *    breaker-trip evidence `{ failures, max, result }`) survives.
 *
 * Drives the REAL `GET /api/security` handler with a real `NextRequest` (`./harness.ts`) against the
 * SQLite test DB (`tests/setup.ts` forces the mock model, so this is fully offline). READ-ONLY: the
 * endpoint writes nothing, so the assertion is purely on the emitted body.
 *
 * Deterministic DB lifecycle: `resetDatabase()` before each test (also clears the durable,
 * OWNER-scoped breaker state), `disconnectTestPrisma()` after.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as securityGet, type SecurityData } from '@/app/api/security/route';
import type { ApiEnvelope } from '@/app/api/_lib/types';
import { recordSecurityEvent } from '@/audit';
import { security } from '@/security';
import { getDemoSession } from '@/agent';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { BASE_URL, sessionCookie } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The gateway's refusal wrapper carrying a serialized, internal decision payload. */
const BLOCK_PAYLOAD = '__SECURITY_BLOCK__{"decisionKind":"deny"}';
/** A raw stack trace — a provider/tool crash must never be user-facing. */
const STACK_TRACE = 'Error: boom\n    at Object.<anonymous> (C:\\work\\tool.js:1:1)';
/** Legitimate audit prose: this MUST survive the projection verbatim (no over-sanitizing). */
const LEGIT_PROSE = '连续 3 次验证失败，已锁定高风险操作。';

/**
 * Trip the OWNER-scoped breaker for `sessionId`. `MFA_MAX_ATTEMPTS` failures lock the owner and
 * emit exactly ONE `CIRCUIT_BREAKER_TRIPPED` event whose `detail` is the SAFE audit record
 * `{ failures, max, result }` — useful as the "safe detail is preserved" counter-case.
 */
async function tripBreaker(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
    await security.circuitBreaker.recordFailure(sessionId);
  }
  expect(await security.circuitBreaker.isLocked(sessionId), 'precondition: the owner breaker is open').toBe(true);
}

/** Invoke `GET /api/security` directly and capture BOTH the raw body text and its parsed JSON. */
async function fetchSecurity(sessionId: string): Promise<{ raw: string; body: ApiEnvelope<SecurityData> }> {
  const req = new NextRequest(`${BASE_URL}/api/security`, {
    method: 'GET',
    headers: { cookie: sessionCookie(sessionId) },
  });
  const res = await securityGet(req);
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, body: JSON.parse(raw) as ApiEnvelope<SecurityData> };
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ============================================================ the public projection contract */

describe('GET /api/security — public projection (no internal-diagnostic leakage)', () => {
  it('[integration] never leaks __SECURITY_BLOCK__ / raw JSON / stack traces / undefined, while preserving structured facts, the safe trip detail and legitimate prose', async () => {
    const sessionId = (await getDemoSession(DEMO_USER_ID)).sessionId;

    // 1) A real breaker trip → one CIRCUIT_BREAKER_TRIPPED event (safe Chinese prose + safe detail).
    await tripBreaker(sessionId);

    // 2) Two diagnostic events (a gateway payload and a stack trace) + one legitimate-prose event
    //    whose `detail` itself carries the marker. Explicit, monotonic timestamps keep the read
    //    deterministic (the endpoint reads newest-first).
    const base = Date.now();
    await recordSecurityEvent({
      sessionId,
      userId: DEMO_USER_ID,
      kind: 'INJECTION_ATTEMPT',
      severity: 'high',
      message: BLOCK_PAYLOAD,
      timestamp: base + 1,
    });
    await recordSecurityEvent({
      sessionId,
      userId: DEMO_USER_ID,
      kind: 'MFA_FAILURE',
      severity: 'medium',
      message: STACK_TRACE,
      timestamp: base + 2,
    });
    await recordSecurityEvent({
      sessionId,
      userId: DEMO_USER_ID,
      kind: 'LIMIT_EXCEEDED',
      severity: 'low',
      message: LEGIT_PROSE,
      detail: { note: BLOCK_PAYLOAD },
      timestamp: base + 3,
    });

    const { raw, body } = await fetchSecurity(sessionId);
    expect(body.ok).toBe(true);
    if (!body.ok) throw new Error('expected a success envelope');
    const data = body.data;

    /* (1) The RAW body carries NO internal diagnostic anywhere. */
    expect(raw, 'a gateway marker must never reach the browser').not.toContain('__SECURITY_BLOCK__');
    expect(raw).not.toContain('decisionKind');
    expect(raw, 'a stack trace must never reach the browser').not.toContain('Error:');
    expect(raw).not.toContain('at Object.');
    expect(raw).not.toContain('"undefined"');

    /* (2) The structured facts are preserved and the event count is not weakened. */
    const persisted = await getTestPrisma().securityEvent.count({ where: { sessionId } });
    expect(persisted, 'precondition: the trip + three events were persisted').toBe(4);
    expect(data.events.length, 'every persisted event is still reported').toBe(persisted);
    for (const event of data.events) {
      expect(typeof event.kind).toBe('string');
      expect(['low', 'medium', 'high']).toContain(event.severity);
      expect(typeof event.timestamp).toBe('number');
      expect(event.sessionId).toBe(sessionId);
    }

    /* (3) Legitimate audit prose is preserved VERBATIM — the projection is not an over-sanitizer. */
    expect(raw, 'real business prose must survive').toContain(LEGIT_PROSE);

    /* (4) A `detail` carrying an internal diagnostic is dropped; a SAFE detail survives. */
    const proseEvent = data.events.find((event) => event.kind === 'LIMIT_EXCEEDED')!;
    expect(proseEvent.message, 'valid prose message preserved').toBe(LEGIT_PROSE);
    expect('detail' in proseEvent, 'a leaky detail is omitted entirely').toBe(false);

    const tripEvent = data.events.find((event) => event.kind === 'CIRCUIT_BREAKER_TRIPPED')!;
    expect(tripEvent.detail, 'the safe breaker-trip detail is preserved').toEqual({
      failures: MFA_MAX_ATTEMPTS,
      max: MFA_MAX_ATTEMPTS,
      result: 'session_locked',
    });

    /* (5) Diagnostic messages are neutralized (never the raw payload). */
    const injectionEvent = data.events.find((event) => event.kind === 'INJECTION_ATTEMPT')!;
    expect(injectionEvent.message, 'a gateway payload message is not forwarded').toBe('');
    const mfaEvent = data.events.find((event) => event.kind === 'MFA_FAILURE')!;
    expect(mfaEvent.message, 'a stack-trace message is not forwarded').toBe('');

    /* (6) The lock / breaker / lockedActions contract is completely unchanged. */
    expect(data.circuitBreaker).toEqual({
      failures: MFA_MAX_ATTEMPTS,
      max: MFA_MAX_ATTEMPTS,
      locked: true,
    });
    expect(data.lock?.code).toBe('CIRCUIT_OPEN');
    expect(data.lock?.reason).toBe('circuit_open');
    expect(Array.isArray(data.lockedActions)).toBe(true);
  });
});