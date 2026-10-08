/**
 * Scenario Test 8 — "把信用卡娱乐限额调整到1500" (YELLOW card-limit change requires confirmation).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → YELLOW confirm → Banking SDK → audit.
 * Fixtures: demo user 李明; the seed ships one 娱乐 limit of ¥3000 on `card_credit`
 * (`CARD_LIMITS`), so the change to ¥1500 is observable both before and after confirmation.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@earendil-works/pi-agent-core';

import { buildFauxAgent, tool, final } from '../helpers/faux-agent';
import {
  runTurn,
  confirmAction,
  newSessionId,
  toolEventsOf,
  cardsOfType,
  type ScenarioResult,
} from '../helpers/scenario';
import { useFreshDatabase, getTestPrisma } from '../helpers/db';
import { CARD_LIMITS } from '../helpers/fixtures';
import type { RiskLevel } from '@/lib/contracts/risk';

/** The seeded 娱乐 limit (¥3000) that the scenario must change to ¥1500. */
const SEEDED = CARD_LIMITS.find(
  (limit) => limit.cardId === 'card_credit' && limit.category === '娱乐',
);
const SEEDED_AMOUNT = SEEDED?.amount ?? 3000;
const TARGET_AMOUNT = 1500;

/** The exact args the model proposes (matches `agent/tools/card.ts` `SetCardLimitParams`). */
const SET_LIMIT_ARGS = { cardId: 'card_credit', category: '娱乐', amount: TARGET_AMOUNT };

useFreshDatabase();

/** Build a unique-session agent whose first turn proposes the gated `set_card_limit` call. */
async function startPendingCardLimit(): Promise<{
  sid: string;
  agent: Agent;
  res: ScenarioResult;
}> {
  const sid = newSessionId();
  const agent = buildFauxAgent({
    sessionId: sid,
    script: [
      tool('set_card_limit', SET_LIMIT_ARGS),
      final('请确认将娱乐限额调整为 1500 元。'),
    ],
  });
  const res = await runTurn({ sessionId: sid, message: '把信用卡娱乐限额调整到1500', agent });
  return { sid, agent, res };
}

/** Narrow (and assert) the YELLOW confirmation the blocked turn must have produced. */
function requireConfirmation(res: ScenarioResult): { actionId: string; tier: RiskLevel } {
  const confirmation = res.confirmation;
  if (confirmation === undefined) {
    throw new Error(`expected a YELLOW confirmation, got none (error: ${res.error ?? 'n/a'})`);
  }
  return { actionId: confirmation.actionId, tier: confirmation.action.tier };
}

describe('Scenario 8 — 信用卡娱乐限额调整到1500 (YELLOW confirm)', () => {
  it('set_card_limit for the 娱乐 category is classified YELLOW and BLOCKED by beforeToolCall', async () => {
    const { res } = await startPendingCardLimit();

    // The gateway blocked the call → the tool never executed inline.
    const events = toolEventsOf(res, 'set_card_limit');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.status === 'blocked')).toBe(true);
    // A blocked (gated) call must NOT surface a success tool event.
    expect(events.some((event) => event.status === 'success')).toBe(false);

    // The tier comes from the code-enforced policy table, never from the model.
    const tier: RiskLevel | undefined = res.confirmation?.action.tier;
    expect(tier).toBe('YELLOW');
    expect(res.confirmation?.action.requiresMfa).toBe(false);
  });

  it('a PendingAction plus a confirmation_required event are produced', async () => {
    const { sid, res } = await startPendingCardLimit();

    expect(res.events.some((event) => event.type === 'confirmation_required')).toBe(true);

    const cards = cardsOfType(res, 'confirmation');
    expect(cards.length).toBe(1);
    expect(cards[0].action.tier).toBe('YELLOW');

    const row = await getTestPrisma().pendingAction.findFirst({
      where: { sessionId: sid, toolName: 'set_card_limit' },
    });
    expect(row).not.toBeNull();
    expect(row?.riskLevel).toBe('YELLOW');
    expect(row?.requiresMfa).toBe(false);
    expect(row?.status).toBe('pending');
  });

  it('NO CardLimit row exists (no 娱乐 limit ¥1500) until the user confirms', async () => {
    const { res } = await startPendingCardLimit();
    // Sanity: the turn really is parked awaiting a human decision.
    expect(res.confirmation).toBeDefined();

    const rows = await getTestPrisma().cardLimit.findMany({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    // Only the untouched seeded row: nothing was written while the action is pending.
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(SEEDED_AMOUNT);
    expect(rows[0].amount).not.toBe(TARGET_AMOUNT);
  });

  it('after confirm the 娱乐 limit is persisted as ¥1500', async () => {
    const { agent, res } = await startPendingCardLimit();
    const { actionId, tier } = requireConfirmation(res);
    expect(tier).toBe('YELLOW');

    const post = await confirmAction(agent, actionId);
    expect(post.error).toBeUndefined();

    // Replace semantics: still exactly ONE row for card+category, now carrying the new amount.
    const rows = await getTestPrisma().cardLimit.findMany({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(TARGET_AMOUNT);
  });

  it('the audit row has riskLevel YELLOW and status success', async () => {
    const { sid, agent, res } = await startPendingCardLimit();
    const { actionId, tier } = requireConfirmation(res);
    expect(tier).toBe('YELLOW');

    await confirmAction(agent, actionId);

    const audit = await getTestPrisma().auditLog.findFirst({
      where: {
        sessionId: sid,
        toolName: 'set_card_limit',
        riskLevel: 'YELLOW',
        status: 'success',
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.confirmed).toBe(true);
    expect(audit?.mfaRequired).toBe(false);
    expect(audit?.status).toBe('success');
  });
});
