/**
 * Unit: security/mfa — audit-event COMPLETENESS for `MFA_FAILURE`.
 *
 * Targets `@/security/mfa` (`issueChallenge`, `verify`) and the persisted `SecurityEvent` rows
 * behind a wrong code. An `MFA_FAILURE` (severity `medium`) record must be COMPLETE — carrying the
 * decision (`reject_code`), the outcome/result (`attempt_counted` | `session_locked`) and the
 * threshold counts (`attempts` / `maxAttempts` / `attemptsLeft` / `locked`) — mirroring the sibling
 * `CIRCUIT_BREAKER_TRIPPED` record.
 *
 * DB-backed (the event is persisted) → needs the test SQLite (`useFreshDatabase()`). The breaker is
 * IN-PROCESS keyed by sessionId → EVERY test uses a UNIQUE sessionId so one test's trip cannot leak
 * into another.
 */
import { describe, expect, it, vi } from 'vitest';

import { issueChallenge, verify } from '@/security/mfa';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import type { Result } from '@/lib/errors';
import { createPendingAction } from '@/lib/db/repositories/pendingAction';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the 10 s default
// hook timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** A unique sessionId per test — breaker state is in-process keyed by sessionId. */
const freshSessionId = (): string => newId('mfa_audit');

/** The prerequisite: a RED `transfer_money` action parked awaiting MFA. */
function seedAction(sessionId: string) {
  return createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { amount: '5000.00', contactId: 'contact_zhangwei' },
    tier: 'RED',
    requiresMfa: true,
    status: 'awaiting_mfa',
    summary: {
      title: '转账',
      toolName: 'transfer_money',
      tier: 'RED',
      fields: [],
      requiresMfa: true,
    },
  });
}

/** Unwrap a success `Result` (fails loudly when the call unexpectedly returned an error). */
function unwrap<T>(res: Result<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value;
}

/** The persisted `MFA_FAILURE` security-event rows for a session. */
function failureEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'MFA_FAILURE' },
  });
}

/** Parse the persisted JSON `detail` text of a security-event row. */
function detailOf(row: { detail: string | null }): Record<string, unknown> {
  return JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
}

describe('mfa · MFA_FAILURE audit-event completeness', () => {
  it('the first wrong code records exactly ONE COMPLETE MFA_FAILURE (severity medium, full detail)', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    unwrap(await verify(action.id, '000000'));

    const events = await failureEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('medium');
    expect(events[0]!.sessionId).toBe(sessionId);
    expect(detailOf(events[0]!)).toEqual({
      actionId: action.id,
      decision: 'reject_code',
      result: 'attempt_counted',
      attempts: 1,
      maxAttempts: MFA_MAX_ATTEMPTS,
      attemptsLeft: 2,
      locked: false,
    });
  });

  it('three consecutive wrong codes: the last record reports the lock, the first two the counted attempt', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
      unwrap(await verify(action.id, '000000'));
    }

    const events = await failureEvents(sessionId);
    expect(events).toHaveLength(MFA_MAX_ATTEMPTS);

    // Order deterministically by the attempt count carried in each detail (row timestamps can tie).
    const details = events
      .map(detailOf)
      .sort((a, b) => (a.attempts as number) - (b.attempts as number));
    expect(details.map((d) => d.attempts)).toEqual([1, 2, 3]);

    expect(details[0]!.result).toBe('attempt_counted');
    expect(details[0]!.locked).toBe(false);
    expect(details[1]!.result).toBe('attempt_counted');
    expect(details[1]!.locked).toBe(false);

    const last = details[MFA_MAX_ATTEMPTS - 1]!;
    expect(last.result).toBe('session_locked');
    expect(last.locked).toBe(true);
    expect(last.attempts).toBe(MFA_MAX_ATTEMPTS);
    expect(last.attemptsLeft).toBe(0);
  });

  it('regression guard: the verify() return value for a wrong code is unchanged', async () => {
    const sessionId = freshSessionId();
    const action = await seedAction(sessionId);
    await issueChallenge(action.id);

    const value = unwrap(await verify(action.id, '000000'));

    expect(value).toEqual({
      ok: false,
      attemptsLeft: 2,
      locked: false,
    });
  });
});
