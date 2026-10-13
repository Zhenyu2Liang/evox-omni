/**
 * Unit: security/circuit-breaker — audit-event COMPLETENESS for the trip + the audited unlock,
 * and the hard gate that a tripped breaker DENIES EVERY tier (incl. 🟢 GREEN reads) via the gateway.
 *
 * Targets `@/security/circuit-breaker` (`recordFailure`, `resetSession`), the persisted
 * `SecurityEvent` rows behind them, and `@/security/security-gateway`
 * (`securityGateway.evaluate` / `decide`) while the session's breaker is locked.
 *
 * Breaker state is DURABLE and keyed by the breaker OWNER (`security/circuit-breaker.ts`
 * `resolveBreakerOwner`). The actor ids here (`newId('cbaudit')`) have no `AgentSession`/`User` row,
 * so each is a distinct `session:<actor>` owner; `useFreshDatabase()` clears `circuitBreakerState`
 * between tests as well. Event persistence needs the test SQLite.
 *
 * The unlock is GATED: a LOCKED owner is only cleared with the mock `MFA_CODE` (or an elapsed
 * cooldown), so every locked-session reset below passes `verificationCode`; a code-less attempt is
 * asserted to be REFUSED and to write NO audit event.
 */
import { describe, expect, it, vi } from 'vitest';

import { recordFailure, resetSession } from '@/security/circuit-breaker';
import { securityGateway, type GatewayContext } from '@/security/security-gateway';
import type { ToolName } from '@/lib/contracts/tools';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

// The per-test DB reset + seed (`useFreshDatabase` → truncateAll + seedDemoData) is I/O heavy
// (~5–7 s with Prisma/SQLite) and can exceed Vitest's 10 s DEFAULT hook timeout, failing the whole
// file for reasons unrelated to the assertions. Give the hook more room (nothing faked/skipped).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** A unique breaker owner per test (no `AgentSession` row → `session:<id>` key). */
const freshSessionId = (): string => newId('cbaudit');

/** The `CIRCUIT_BREAKER_TRIPPED` security-event rows persisted for a session. */
function tripEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' },
  });
}

/** The `SECURITY_RESET` security-event rows persisted for a session. */
function resetEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'SECURITY_RESET' },
  });
}

/** Trip a fresh session's breaker by recording `MFA_MAX_ATTEMPTS` consecutive failures. */
async function tripBreaker(sessionId: string): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
    await recordFailure(sessionId);
  }
}

/** Parse the persisted JSON `detail` text of a security-event row. */
function detailOf(row: { detail: string | null }): Record<string, unknown> {
  return JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
}

/** A proposed tool call for the gateway (`sessionId` resolves to that actor's breaker owner). */
function ctxFor(
  toolName: ToolName,
  args: Record<string, unknown>,
  sessionId: string,
): GatewayContext {
  return { sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: '演示请求' };
}

describe('circuit-breaker · CIRCUIT_BREAKER_TRIPPED audit event', () => {
  it('records ONE complete trip event: severity high, non-empty message, exact detail', async () => {
    const sessionId = freshSessionId();

    await tripBreaker(sessionId);

    const events = await tripEvents(sessionId);
    expect(events).toHaveLength(1);
    const row = events[0]!;
    expect(row.kind).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(row.severity).toBe('high');
    expect(typeof row.message).toBe('string');
    expect(row.message.length).toBeGreaterThan(0);
    expect(detailOf(row)).toEqual({
      failures: MFA_MAX_ATTEMPTS,
      max: MFA_MAX_ATTEMPTS,
      result: 'session_locked',
    });
  });
});

describe('circuit-breaker · SECURITY_RESET audit event (audited unlock)', () => {
  it('records ONE SECURITY_RESET with explicit actor/reason attribution when the session was locked', async () => {
    const sessionId = freshSessionId();
    await tripBreaker(sessionId);

    await resetSession(sessionId, {
      actor: 'security-admin',
      reason: '用户致电客服核实身份后解除',
      verificationCode: MFA_CODE,
    });

    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    const detail = detailOf(events[0]!);
    expect(detail.actor).toBe('security-admin');
    expect(detail.reason).toBe('用户致电客服核实身份后解除');
    expect(detail.wasLocked).toBe(true);
    expect(detail.previousFailures).toBe(MFA_MAX_ATTEMPTS);
    expect(typeof detail.priorLockedAt).toBe('number');
  });

  it('defaults actor to "user" and reason to a non-empty string when opts are omitted (locked session)', async () => {
    const sessionId = freshSessionId();
    await tripBreaker(sessionId);

    await resetSession(sessionId, { verificationCode: MFA_CODE });

    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    const detail = detailOf(events[0]!);
    expect(detail.actor).toBe('user');
    expect(typeof detail.reason).toBe('string');
    expect((detail.reason as string).length).toBeGreaterThan(0);
    expect(detail.wasLocked).toBe(true);
    expect(detail.previousFailures).toBe(MFA_MAX_ATTEMPTS);
  });

  it('records wasLocked=false, previousFailures=1 and NO priorLockedAt on a NON-locked session', async () => {
    const sessionId = freshSessionId();
    await recordFailure(sessionId); // one failure — not locked

    await resetSession(sessionId);

    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    const detail = detailOf(events[0]!);
    expect(detail.wasLocked).toBe(false);
    expect(detail.previousFailures).toBe(1);
    expect('priorLockedAt' in detail).toBe(false);
    expect(detail.priorLockedAt).toBeUndefined();
  });

  it('a REFUSED (code-less) unlock of a locked session writes NO SECURITY_RESET event', async () => {
    const sessionId = freshSessionId();
    await tripBreaker(sessionId);

    await expect(resetSession(sessionId)).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });

    // A refused unlock must leave no audit trail claiming the account was unlocked.
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });
});

describe('circuit-breaker · locked session denies EVERY tier (incl. 🟢 GREEN reads)', () => {
  it('a tripped breaker blocks GREEN/YELLOW/RED alike with HIGH_RISK_BLOCKED + decision deny', async () => {
    const sessionId = freshSessionId();
    await tripBreaker(sessionId);

    const calls: ReadonlyArray<{ toolName: ToolName; args: Record<string, unknown> }> = [
      { toolName: 'get_balance', args: {} }, // 🟢 GREEN read
      { toolName: 'set_card_limit', args: {} }, // 🟡 YELLOW
      { toolName: 'transfer_money', args: { amount: '200.00' } }, // 🟡 YELLOW (dynamic)
      { toolName: 'subscribe_investment', args: {} }, // 🔴 RED
    ];

    for (const { toolName, args } of calls) {
      const ctx = ctxFor(toolName, args, sessionId);
      const ev = await securityGateway.evaluate(ctx);

      expect(ev.blocked).toBe(true);
      expect(ev.blockReason).toBe('HIGH_RISK_BLOCKED');
      expect(securityGateway.decide(ev, ctx).kind).toBe('deny');
    }
  });

  it('after the audited unlock, a GREEN read is allowed again for the SAME session', async () => {
    const sessionId = freshSessionId();
    await tripBreaker(sessionId);

    expect((await securityGateway.evaluate(ctxFor('get_balance', {}, sessionId))).blocked).toBe(
      true,
    );

    await resetSession(sessionId, { verificationCode: MFA_CODE });

    const ev = await securityGateway.evaluate(ctxFor('get_balance', {}, sessionId));
    expect(ev.blocked).toBe(false);
    expect(ev.tier).toBe('GREEN');
  });
});
