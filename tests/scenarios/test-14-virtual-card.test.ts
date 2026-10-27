/**
 * Scenario 14 — "帮我申请一张月限额2000元的虚拟卡" (agent-enabled RED apply_virtual_card, code 123456).
 *
 * Feature 4: `apply_virtual_card` is now agent-REACHABLE (offered to the model) and RED — a call is
 * blocked by the Security Gateway's `beforeToolCall`, parks an `awaiting_mfa` PendingAction and only
 * issues the VIRTUAL card once a human supplies the code. The model-free execution path (used by the
 * confirmation flow, plan nodes and retries) is idempotent per `idempotencyKey`.
 *
 * Fixtures: demo user 李明; no VIRTUAL card in the seed. The issued card is ACCOUNT-BOUND at creation:
 * the model names no settlement account, so the server binds the user's ONLY checking account
 * (`acct_checking`, 活期账户 ****8821) — a virtual card that could not spend is never minted.
 * Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { moneyToCents } from '@/lib/money';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, tool } from '../helpers/faux-agent';
import { cardsOfType, newSessionId, runTurn, toolEventsOf, verifyAction } from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

const MONTHLY_LIMIT = '2000.00';
const USER_REQUEST = '帮我申请一张月限额2000元的虚拟卡';
/**
 * The one CHECKING account of the demo user (`ACCOUNTS` in ../helpers/fixtures): 活期账户 ****8821,
 * ¥23,580.00. A VIRTUAL card is account-bound at creation and the model never names an account — the
 * server resolves the user's ONLY checking account (`resolveLinkedAccount`).
 */
const SETTLEMENT = 'acct_checking';
const SETTLEMENT_MASKED = '****8821';
const SETTLEMENT_BALANCE = '23580.00';

/** Drive a fresh turn whose single model step proposes the RED `apply_virtual_card` call. */
async function proposeVirtualCard(): Promise<{
  sessionId: string;
  agent: ReturnType<typeof buildFauxAgent>;
  res: Awaited<ReturnType<typeof runTurn>>;
}> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('apply_virtual_card', { monthlyLimit: MONTHLY_LIMIT })],
  });
  const res = await runTurn({ sessionId, message: USER_REQUEST, agent });
  return { sessionId, agent, res };
}

describe('Scenario 14 — 申请虚拟卡 (RED MFA apply_virtual_card)', () => {
  it('is offered to the model and classified RED (blocked, not executed inline)', async () => {
    const registry = createToolRegistry(DEMO_USER_ID);
    expect(registry.list().map((entry) => entry.name)).toContain('apply_virtual_card');
    expect(registry.get('apply_virtual_card').name).toBe('apply_virtual_card');

    const { res } = await proposeVirtualCard();

    expect(res.mfa).toBeDefined();
    expect(res.confirmation).toBeUndefined();
    expect(res.events.some((event) => event.type === 'mfa_required')).toBe(true);
    expect(cardsOfType(res, 'mfa').length).toBeGreaterThan(0);

    const events = toolEventsOf(res, 'apply_virtual_card');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.status === 'blocked')).toBe(true);
  });

  it('parks a RED awaiting_mfa PendingAction and issues NO virtual card before MFA', async () => {
    const { sessionId, res } = await proposeVirtualCard();
    const actionId = res.mfa!.actionId;

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.sessionId).toBe(sessionId);
    expect(row.toolName).toBe('apply_virtual_card');
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(row.status).toBe('awaiting_mfa');
    expect(JSON.parse(row.argsJson)).toEqual({ monthlyLimit: MONTHLY_LIMIT });
    // The model never names a settlement account: the SDK resolves it at creation (asserted below).

    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(0);
  });

  it('verifyAction(123456) issues a VIRTUAL card with the requested monthly limit', async () => {
    const { agent, res } = await proposeVirtualCard();

    await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

    const cards = await getTestPrisma().card.findMany({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' } });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.status).toBe('ACTIVE');
    expect(card.network).toBe('UnionPay');
    expect(card.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(card.monthlyLimitMinor).toBe(moneyToCents(MONTHLY_LIMIT));
    // A virtual card carries no credit limit and no per-category limits.
    expect(card.creditLimitMinor).toBeNull();
    expect(card.availableLimitMinor).toBeNull();
    // Account-bound at creation (the model supplied no account: the server resolved the ONLY CHECKING).
    expect(card.linkedAccountId).toBe(SETTLEMENT);
    expect(await getTestPrisma().cardLimit.count({ where: { cardId: card.id } })).toBe(0);

    // The projection resolves that binding to LINKED: the card spends the ACCOUNT's cash (it owns no
    // balance of its own), capped by its own limit — min(23,580.00 cash, 2,000.00 remaining limit).
    const view = (await banking.card.getCards(DEMO_USER_ID)).find((entry) => entry.id === card.id);
    expect(view).toBeDefined();
    expect(view!.linkedAccountId).toBe(SETTLEMENT);
    expect(view!.linkedAccountStatus).toBe('LINKED');
    expect(view!.linkedAccountNumber).toBe(SETTLEMENT_MASKED);
    expect(view!.accountAvailableBalance).toBe(SETTLEMENT_BALANCE);
    expect(view!.payableAmount).toBe(MONTHLY_LIMIT);
    expect(view!.usable).toBe(true);

    expect(
      (await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: res.mfa!.actionId } })).status,
    ).toBe('confirmed');
  });

  it('records a RED audit row with mfaRequired true and mfaResult success', async () => {
    const { sessionId, agent, res } = await proposeVirtualCard();

    await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId, toolName: 'apply_virtual_card', status: 'success' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ riskLevel: 'RED', mfaRequired: true, mfaResult: 'success', confirmed: true });
  });

  it('replays the SAME idempotency key instead of issuing a second card (SDK level)', async () => {
    const first = await banking.card.applyVirtualCard({
      userId: DEMO_USER_ID,
      monthlyLimit: '1500.00',
      idempotencyKey: 'vc-key-1',
    });
    const second = await banking.card.applyVirtualCard({
      userId: DEMO_USER_ID,
      monthlyLimit: '1500.00',
      idempotencyKey: 'vc-key-1',
    });

    expect(second.id).toBe(first.id);
    expect(second.numberMasked).toBe(first.numberMasked);
    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(1);

    // A DIFFERENT monthly limit under the SAME identity is a CONFLICT — never a silent second card.
    await expect(
      banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: '1600.00', idempotencyKey: 'vc-key-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(1);
  });

  it('executeDirect with a repeated idempotency key replays the original card', async () => {
    const registry = createToolRegistry(DEMO_USER_ID);

    const first = await registry.executeDirect(
      'apply_virtual_card',
      { monthlyLimit: '800.00' },
      { idempotencyKey: 'op-vc-1' },
    );
    expect(first.ok).toBe(true);
    const firstId = (first.data as { id: string }).id;

    const second = await registry.executeDirect(
      'apply_virtual_card',
      { monthlyLimit: '800.00' },
      { idempotencyKey: 'op-vc-1' },
    );
    expect(second.ok).toBe(true);
    expect((second.data as { id: string }).id).toBe(firstId);
    expect(await getTestPrisma().card.count({ where: { type: 'VIRTUAL' } })).toBe(1);
  });
});
