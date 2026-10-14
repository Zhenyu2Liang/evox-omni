/**
 * Scenario Test 1 — "查询我的余额" (GREEN auto-execute balance read).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each test.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 *
 * Only the MODEL is scripted (`buildFauxAgent`); the tools, the `beforeToolCall` security
 * chokepoint, the Banking SDK and the DB are the real ones — so this proves real behaviour.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BalanceView } from '@/banking-sdk';
import { moneyToCents } from '@/lib/money';
import { security } from '@/security';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import {
  cardsOfType,
  newSessionId,
  runTurn,
  toolEventsOf,
  type ScenarioResult,
} from '../helpers/scenario';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '../helpers/db';
import { ACCOUNTS, DEMO_USER_ID } from '../helpers/fixtures';

beforeEach(async () => {
  await resetDatabase();
}, 30000);
afterAll(async () => {
  await disconnectTestPrisma();
});

/** The seeded 活期 account (`acct_checking`, 活期账户 ¥23,580) — the default funding account. */
const CHECKING = ACCOUNTS[0];

/** The factual narration the scripted model produces after the tool result. */
const NARRATION = '您的活期余额为 ¥23,580.00。';

/**
 * Run the canonical GREEN turn: scripted `get_balance` call → inline execute → scripted final
 * narration. Each call uses a UNIQUE `sessionId` so the in-process circuit breaker is isolated.
 */
function runBalanceTurn(sessionId: string): Promise<ScenarioResult> {
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('get_balance', {}), final(NARRATION)],
  });
  return runTurn({ sessionId, message: '查询我的余额', agent });
}

describe('Scenario 1 — 查询余额 (GREEN auto-execute)', () => {
  it('seeds the demo world and scripts a get_balance call for "查询我的余额"', async () => {
    const prisma = getTestPrisma();

    // The canonical demo world is present: user 李明 + the 活期 account at ¥23,580.
    expect(await prisma.user.findUnique({ where: { id: DEMO_USER_ID } })).not.toBeNull();
    const seeded = await prisma.account.findUnique({ where: { id: CHECKING.id } });
    expect(seeded).not.toBeNull();
    expect(seeded!.name).toBe('活期账户');
    expect(seeded!.balanceMinor).toBe(moneyToCents('23580.00'));

    // The scripted model proposes get_balance and the turn runs to completion.
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);
    expect(res.sessionId).toBe(sessionId);
    expect(toolEventsOf(res, 'get_balance').length).toBeGreaterThan(0);
    expect(res.error).toBeUndefined();
  });

  it('get_balance executes inline with NO confirmation (no PendingAction created)', async () => {
    const prisma = getTestPrisma();
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);

    // GREEN auto-executes: the turn never parks awaiting a human decision.
    expect(res.confirmation).toBeUndefined();
    expect(res.mfa).toBeUndefined();
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('the get_balance tool event reports status success', async () => {
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);

    const events = toolEventsOf(res, 'get_balance');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('success');
    // The tool's own factual summary (the text the model may narrate).
    expect(events[0].summary).toContain('活期账户');
    expect(events[0].summary).toContain('23,580');
  });

  it('a balance card is surfaced showing 活期账户 ¥23,580.00 (ACCOUNTS[checking])', async () => {
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);

    const cards = cardsOfType(res, 'balance');
    expect(cards.length).toBeGreaterThan(0);

    // The card payload is the SDK's `BalanceView` (see agent/card-emitter.ts).
    const data = cards[0].data as BalanceView;
    expect(data.currency).toBe('CNY');
    expect(data.totalAvailable).toBe('73580.00');

    const checking = data.accounts.find((account) => account.id === CHECKING.id);
    expect(checking).toBeDefined();
    expect(checking!.name).toBe('活期账户');
    expect(checking!.balance).toBe('23580.00');
    expect(checking!.currency).toBe('CNY');
  });

  it('the gateway classifies get_balance GREEN (allowed) — the tier the tool event does not carry', async () => {
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);

    // A SUCCESS `ToolEventView` carries no `tier` (only status/summary), so the GREEN fact is read at
    // the exact chokepoint the model cannot bypass: the gateway `beforeToolCall` calls.
    // NOTE: the auto-execute path persists NO `AuditLog` row today (audit rows are written for gated
    // confirm/verify/cancel decisions), so the tier is asserted on the real gateway evaluation.
    const auth = await security.gateway.securityGateway.handleToolCall({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: 'get_balance',
      args: { accountId: CHECKING.id },
      userRequest: '查询我的余额',
    });

    expect(auth.evaluation.tier).toBe('GREEN');
    expect(auth.evaluation.blocked).toBe(false);
    expect(auth.decision.kind).toBe('allow');
    // GREEN carries no pending action — nothing to confirm/verify.
    expect(auth.action).toBeUndefined();
    expect(res.confirmation).toBeUndefined();
  });

  it('the assistant narration restates the factual balance from the tool result', async () => {
    const sessionId = newSessionId('s1');
    const res = await runBalanceTurn(sessionId);

    expect(res.text).toContain('23,580');
    expect(res.error).toBeUndefined();
  });
});
