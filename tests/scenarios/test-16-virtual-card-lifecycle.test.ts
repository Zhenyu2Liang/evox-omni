/**
 * Scenario 16 — 虚拟卡「申请 → 消费 → 挂失 → 补办 → 继续消费」全生命周期，以及
 * 月限额 / 零限额 / 未设限额 与 重放幂等 的语义 (RED MFA, code 123456).
 *
 * Pipeline (real product layers, only the MODEL is scripted):
 *   user message → Pi Agent (faux script) → banking tool → Security Gateway `beforeToolCall`
 *   → RED ⇒ a `PendingAction` parks as `awaiting_mfa` and the call is BLOCKED → human submits the
 *   code (`verifyAction`) → the gateway executes the ORIGINAL validated args through the banking
 *   tool registry → Banking SDK (exact minor units) → audit.
 *
 * What this spec proves:
 *  1. The whole LIFECYCLE of a repaired VIRTUAL card family through the gated (MFA) path: a VIRTUAL
 *     card is issued only after the code, spending debits its linked CHECKING account exactly, loss
 *     is terminal, replacement mints exactly ONE new ACTIVE VIRTUAL card on the SAME settlement
 *     account with the SAME monthly limit, the already-booked `CardConsumption` rows stay attributed
 *     to the card that incurred them, and the monthly allowance CONTINUES across the replacement
 *     (30.00 before + 70.00 after = the 100.00 limit) so the next 71.00 is refused with NOTHING moved.
 *  2. Replacement replay at the scenario layer. IMPORTANT reasoning: a *fresh model-driven* gated
 *     attempt WOULD legitimately re-gate — the Security Gateway persists a `PendingAction` per tool
 *     call and cannot know about the SDK's application-level idempotency, so re-gating is correct
 *     behaviour there, not a defect. What IS guaranteed (and asserted here) is the model-free
 *     execution path that plan nodes / confirmations / retries use: replaying the SAME authorized
 *     `replace_card` execution returns the EXISTING replacement card, mints no second card and does
 *     not touch the source's `replacedByCardId`.
 *  3. Consumption replay: the SAME execution identity charges once and returns the persisted
 *     snapshot; the same identity re-pointed at a DIFFERENT card is a `CONFLICT` with no second debit.
 *  4. `monthlyLimit: '0.00'` is a legal limit that refuses ANY consumption.
 *  5. An ABSENT monthly limit is cash-bound: `payableAmount` equals the account cash, a spend within
 *     cash succeeds, and a spend above the remaining cash is `INSUFFICIENT_FUNDS` with no partial
 *     debit, no `channel='CARD'` ledger row and no `CardConsumption` row.
 *
 * Not duplicated here (covered elsewhere): DEBIT replacement and the LOST precondition
 * (`test-13`), virtual-card application itself (`test-14`), the credit-limit guard and the YELLOW
 * `set_card_limit` flow (`test-15`, `test-08`).
 *
 * Fixtures: demo user 李明 (`user_liming`); `acct_checking` (CHECKING, 23580.00) is the settlement
 * account; the seed already holds `channel='CARD'` ledger rows and NO virtual card, so every ledger
 * and consumption assertion is a DELTA against a pre-spend snapshot of row ids. Helpers: ../helpers/*.
 *
 * Isolation: the shared test reset (`truncateAll` in ../helpers/db.ts) clears `CardConsumption` too,
 * so a fixed `executionKey` replay cannot leak between tests.
 */
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { moneyToCents } from '@/lib/money';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import {
  cardsOfType,
  newSessionId,
  runTurn,
  toolEventsOf,
  verifyAction,
  type ScenarioResult,
} from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

/** The settlement account every VIRTUAL card in this spec is bound to (the user's default CHECKING). */
const ACCOUNT = 'acct_checking';
/** The monthly limit used for the repaired-family lifecycle. */
const LIMIT_100 = '100.00';
/** Neutral, truthful narration the scripted model emits after a gated call (never a panel claim). */
const BLOCKED_NARRATION = '该项操作需要短信验证码验证。';
/** The execution identity used by the consumption-replay case. */
const EXECUTION_KEY = 'scenario-consume-key-1';

/** The subset of the SDK `CardView` DTO the tool runners return (exact money strings). */
interface CardViewData {
  id: string;
  type: string;
  status: string;
  network: string;
  numberMasked: string;
  monthlyLimit?: string;
  replacedByCardId?: string;
  linkedAccountId?: string;
  linkedAccountNumber?: string;
  accountAvailableBalance?: string;
  payableAmount?: string;
}

/** The `consume_virtual_card` tool payload (`ConsumeCardResult` + the exact DTO views). */
interface ConsumeToolData {
  consumption: {
    id: string;
    cardId: string;
    accountId: string;
    amount: string;
    currency: string;
    category: string;
    merchant: string;
    executionKey?: string;
  };
  card: CardViewData;
  accountAvailableBalance: string;
}

const prisma = () => getTestPrisma();

/* ------------------------------------------------------------------ DB snapshots & deltas */

/** Exact CNY minor units of the settlement account (never a float). */
async function balanceMinor(): Promise<bigint> {
  return (await prisma().account.findUniqueOrThrow({ where: { id: ACCOUNT } })).balanceMinor;
}

function cardRow(cardId: string) {
  return prisma().card.findUniqueOrThrow({ where: { id: cardId } });
}

function pendingRow(actionId: string) {
  return prisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
}

/** The demo user's VIRTUAL cards (the seed has none, so any row here was minted by this scenario). */
function virtualCardRows() {
  return prisma().card.findMany({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' }, orderBy: { id: 'asc' } });
}

function userCardCount(): Promise<number> {
  return prisma().card.count({ where: { userId: DEMO_USER_ID } });
}

/** Audit rows for one tool inside one session (the gateway/decision trail). */
function auditRows(sessionId: string, toolName: string) {
  return prisma().auditLog.findMany({
    where: { sessionId, toolName },
    orderBy: [{ timestamp: 'asc' }],
  });
}

/** Snapshot row ids so a later assertion measures THIS scenario's delta, not the seeded history. */
async function ledgerIds(): Promise<Set<string>> {
  const rows = await prisma().transaction.findMany({
    where: { accountId: ACCOUNT, channel: 'CARD' },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

async function consumptionIds(): Promise<Set<string>> {
  const rows = await prisma().cardConsumption.findMany({ where: { userId: DEMO_USER_ID }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

/** `channel='CARD'` ledger rows booked against the settlement account AFTER the snapshot. */
async function ledgerRowsSince(before: Set<string>) {
  const rows = await prisma().transaction.findMany({
    where: { accountId: ACCOUNT, channel: 'CARD' },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return rows.filter((row) => !before.has(row.id));
}

/** `CardConsumption` rows created AFTER the snapshot. */
async function consumptionsSince(before: Set<string>) {
  const rows = await prisma().cardConsumption.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.filter((row) => !before.has(row.id));
}

/* ---------------------------------------------------------------------------- turn driving */

/**
 * Drive ONE gated turn on a shared session: the scripted model proposes `toolName(args)` and then
 * narrates, so the two scripted steps are exactly consumed by the turn (proposal + continuation).
 *
 * The script queue is therefore EMPTY when the human decision runs, which lets `verifyAction` seed
 * its own factual narration — a fresh scripted agent per turn (same `sessionId`) keeps that contract
 * intact while the whole lifecycle still shares ONE session (one PendingAction/audit trail).
 */
async function propose(
  sessionId: string,
  message: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ agent: ReturnType<typeof buildFauxAgent>; res: ScenarioResult }> {
  const agent = buildFauxAgent({ sessionId, script: [tool(toolName, args), final(BLOCKED_NARRATION)] });
  const res = await runTurn({ sessionId, message, agent });
  return { agent, res };
}

/** Assert that `toolName` was BLOCKED by the gate (nothing executed inline) and return the actionId. */
function expectGated(res: ScenarioResult, toolName: string): string {
  expect(res.mfa, `${toolName} must park for MFA`).toBeDefined();
  expect(res.confirmation).toBeUndefined();
  expect(res.events.some((event) => event.type === 'mfa_required')).toBe(true);
  expect(cardsOfType(res, 'mfa').length).toBeGreaterThan(0);
  const events = toolEventsOf(res, toolName);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.status === 'blocked')).toBe(true);
  return res.mfa!.actionId;
}

describe('Scenario 16 — 虚拟卡补办生命周期与限额语义 (RED MFA card family)', () => {
  it('drives apply → consume → report lost → replace → continued allowance through the MFA gate', async () => {
    const sessionId = newSessionId();
    const startBalance = await balanceMinor();
    const startLedger = await ledgerIds();
    const startCards = await userCardCount();

    /* (a) apply_virtual_card { monthlyLimit: '100.00' } → BLOCKED, nothing minted before MFA ---- */
    const apply = await propose(sessionId, '帮我开一张月限额 100 元的虚拟卡', 'apply_virtual_card', {
      monthlyLimit: LIMIT_100,
    });
    const applyActionId = expectGated(apply.res, 'apply_virtual_card');

    const applyAction = await pendingRow(applyActionId);
    expect(applyAction).toMatchObject({
      sessionId,
      toolName: 'apply_virtual_card',
      riskLevel: 'RED',
      requiresMfa: true,
      status: 'awaiting_mfa',
    });
    // The gateway persisted the ORIGINAL validated args — never model text.
    expect(JSON.parse(applyAction.argsJson)).toEqual({ monthlyLimit: LIMIT_100 });
    expect(await virtualCardRows()).toHaveLength(0);
    expect(await userCardCount()).toBe(startCards);

    await verifyAction(apply.agent, applyActionId, MFA_CODE);

    const [virtual] = await virtualCardRows();
    expect(virtual).toBeDefined();
    const cardId = virtual.id;
    expect(virtual.status).toBe('ACTIVE');
    expect(virtual.type).toBe('VIRTUAL');
    expect(virtual.userId).toBe(DEMO_USER_ID);
    expect(virtual.monthlyLimitMinor).toBe(moneyToCents(LIMIT_100));
    expect(virtual.linkedAccountId).toBe(ACCOUNT);
    expect((await pendingRow(applyActionId)).status).toBe('confirmed');
    // Issuing a card is not a money movement.
    expect(await balanceMinor()).toBe(startBalance);
    expect(await ledgerRowsSince(startLedger)).toHaveLength(0);
    const applyAudit = await auditRows(sessionId, 'apply_virtual_card');
    expect(applyAudit.some((row) => row.status === 'success')).toBe(true);
    expect(applyAudit[0]).toMatchObject({ riskLevel: 'RED', mfaRequired: true, mfaResult: 'success', confirmed: true });

    /* (b) consume_virtual_card 30.00 → BLOCKED, then exactly one debit + CARD ledger row --------- */
    const consume30 = await propose(sessionId, '用这张虚拟卡在便利店消费 30 元', 'consume_virtual_card', {
      cardId,
      amount: '30.00',
      merchant: '全家便利店',
    });
    const consume30Id = expectGated(consume30.res, 'consume_virtual_card');
    // Nothing moves while the human has not supplied the code.
    expect(await balanceMinor()).toBe(startBalance);
    expect(await consumptionsSince(await consumptionIds())).toHaveLength(0);

    const consume30Ledger = await ledgerIds();
    const consume30Consumptions = await consumptionIds();
    await verifyAction(consume30.agent, consume30Id, MFA_CODE);

    expect(await balanceMinor()).toBe(startBalance - moneyToCents('30.00'));
    const ledger30 = await ledgerRowsSince(consume30Ledger);
    expect(ledger30).toHaveLength(1);
    expect(ledger30[0]).toMatchObject({
      accountId: ACCOUNT,
      userId: DEMO_USER_ID,
      channel: 'CARD',
      direction: 'DEBIT',
      currency: 'CNY',
      amountMinor: -moneyToCents('30.00'),
      merchant: '全家便利店',
    });
    const consumption30 = await consumptionsSince(consume30Consumptions);
    expect(consumption30).toHaveLength(1);
    expect(consumption30[0]).toMatchObject({
      cardId,
      accountId: ACCOUNT,
      userId: DEMO_USER_ID,
      currency: 'CNY',
      amountMinor: moneyToCents('30.00'),
      category: '其他',
      merchant: '全家便利店',
    });
    const consumeAudit = (await auditRows(sessionId, 'consume_virtual_card')).filter((row) => row.status === 'success');
    expect(consumeAudit).toHaveLength(1);
    expect(consumeAudit[0]).toMatchObject({
      riskLevel: 'RED',
      mfaRequired: true,
      mfaResult: 'success',
      confirmed: true,
    });

    /* (c) report_lost_card → BLOCKED, then the card is terminally LOST ---------------------------- */
    const lost = await propose(sessionId, '我的虚拟卡丢了，帮我挂失', 'report_lost_card', { cardId });
    const lostId = expectGated(lost.res, 'report_lost_card');
    expect((await cardRow(cardId)).status).toBe('ACTIVE');

    await verifyAction(lost.agent, lostId, MFA_CODE);
    expect((await cardRow(cardId)).status).toBe('LOST');
    // Loss reporting moves no money and creates no consumption.
    expect(await balanceMinor()).toBe(startBalance - moneyToCents('30.00'));
    expect(await ledgerRowsSince(consume30Ledger)).toHaveLength(1);

    /* (d) replace_card → BLOCKED, then exactly ONE new ACTIVE VIRTUAL card on the SAME account ---- */
    const cardsBeforeReplace = await userCardCount();
    const replace = await propose(sessionId, '帮我补办这张虚拟卡', 'replace_card', { cardId });
    const replaceId = expectGated(replace.res, 'replace_card');
    expect(await userCardCount()).toBe(cardsBeforeReplace);
    expect((await cardRow(cardId)).replacedByCardId).toBeNull();

    await verifyAction(replace.agent, replaceId, MFA_CODE);

    expect(await userCardCount()).toBe(cardsBeforeReplace + 1);
    const source = await cardRow(cardId);
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).not.toBeNull();
    const replacementId = source.replacedByCardId!;
    expect(replacementId).not.toBe(cardId);

    const replacement = await cardRow(replacementId);
    expect(replacement).toMatchObject({
      userId: DEMO_USER_ID,
      type: 'VIRTUAL',
      network: virtual.network,
      status: 'ACTIVE',
      linkedAccountId: ACCOUNT,
      monthlyLimitMinor: moneyToCents(LIMIT_100),
      replacedByCardId: null,
    });
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacement.numberMasked).not.toBe(source.numberMasked);
    // History is NOT rewritten: every consumption of this card FAMILY still belongs to the SOURCE.
    expect(await prisma().cardConsumption.count({ where: { cardId: replacementId } })).toBe(0);
    const familyRows = await prisma().cardConsumption.findMany({
      where: { userId: DEMO_USER_ID, cardId: { in: [cardId, replacementId] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { cardId: true },
    });
    expect(familyRows.map((row) => row.cardId)).toEqual([cardId]);
    expect(await balanceMinor()).toBe(startBalance - moneyToCents('30.00'));

    /* (e) consume 70.00 from the REPLACEMENT: the allowance continues (30 + 70 = the 100 limit) --- */
    const ledgerBefore70 = await ledgerIds();
    const consumptionsBefore70 = await consumptionIds();
    const balanceBefore70 = await balanceMinor();
    const consume70 = await propose(sessionId, '用补办后的新卡消费 70 元', 'consume_virtual_card', {
      cardId: replacementId,
      amount: '70.00',
      merchant: '加油站',
    });
    const consume70Id = expectGated(consume70.res, 'consume_virtual_card');
    expect(await balanceMinor()).toBe(balanceBefore70);

    await verifyAction(consume70.agent, consume70Id, MFA_CODE);

    expect(await balanceMinor()).toBe(balanceBefore70 - moneyToCents('70.00'));
    const consumption70 = await consumptionsSince(consumptionsBefore70);
    expect(consumption70).toHaveLength(1);
    expect(consumption70[0]).toMatchObject({
      cardId: replacementId,
      accountId: ACCOUNT,
      amountMinor: moneyToCents('70.00'),
      merchant: '加油站',
    });
    const ledger70 = await ledgerRowsSince(ledgerBefore70);
    expect(ledger70).toHaveLength(1);
    expect(ledger70[0].amountMinor).toBe(-moneyToCents('70.00'));
    // The FAMILY's current-month spend (both replacement directions) now equals the limit exactly.
    const familySpend = await prisma().cardConsumption.aggregate({
      where: { userId: DEMO_USER_ID, cardId: { in: [cardId, replacementId] } },
      _sum: { amountMinor: true },
    });
    expect(familySpend._sum.amountMinor).toBe(moneyToCents(LIMIT_100));

    /* (f) 71.00 would exceed the limit → LIMIT_EXCEEDED and NOTHING moves -------------------------- */
    const balanceBeforeOver = await balanceMinor();
    const ledgerBeforeOver = await ledgerIds();
    const consumptionsBeforeOver = await consumptionIds();
    const cardsBeforeOver = await userCardCount();
    const over = await propose(sessionId, '再用这张卡消费 71 元', 'consume_virtual_card', {
      cardId: replacementId,
      amount: '71.00',
    });
    // Still gated: the gateway cannot know the remaining allowance, the SDK enforces it.
    const overId = expectGated(over.res, 'consume_virtual_card');

    const denied = await verifyAction(over.agent, overId, MFA_CODE);

    // The human decision is recorded (authorized RED) but the SDK refused the write.
    /*
     * Status semantics: the scenario decision path (`verifyAction` → `decideAndContinue`) stops the
     * action at `confirmed` — it runs the ORIGINAL authorized args and records the audit row, but
     * does not settle the terminal status the way the PRODUCTION confirmation path does
     * (`agent/confirmation/authorized-execution.ts` → `settlePendingAction` + `recordActionResult`
     * would leave it `failed`). What this line pins is that the human decision was consumed exactly
     * once and the action never re-surfaces as a pending prompt; the production-consistent evidence
     * for the refusal is the `status:'failed'` audit row asserted below.
     */
    expect((await pendingRow(overId)).status).toBe('confirmed');
    expect(denied.text).toContain('限额');
    expect(await balanceMinor()).toBe(balanceBeforeOver);
    expect(await ledgerRowsSince(ledgerBeforeOver)).toHaveLength(0);
    expect(await consumptionsSince(consumptionsBeforeOver)).toHaveLength(0);
    expect(await userCardCount()).toBe(cardsBeforeOver);
    expect((await cardRow(replacementId)).status).toBe('ACTIVE');
    expect((await cardRow(cardId)).status).toBe('LOST');

    const failures = (await auditRows(sessionId, 'consume_virtual_card')).filter((row) => row.status === 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ riskLevel: 'RED', mfaRequired: true, mfaResult: 'success', confirmed: true });

    // Total cash moved over the whole lifecycle is exactly the two successful spends.
    expect(await balanceMinor()).toBe(startBalance - moneyToCents('30.00') - moneyToCents('70.00'));
    expect(await ledgerRowsSince(startLedger)).toHaveLength(2);
  });

  it('replays an authorized replacement instead of minting a second card', async () => {
    const sessionId = newSessionId();
    // Setup precondition through the real SDK: a VIRTUAL card, then the TERMINAL loss.
    const issued = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: LIMIT_100 });
    const lost = await banking.card.reportLostCard(issued.id, DEMO_USER_ID, { reason: '遗失' });
    expect(lost.status).toBe('LOST');

    const replace = await propose(sessionId, '帮我补办这张虚拟卡', 'replace_card', { cardId: issued.id });
    const actionId = expectGated(replace.res, 'replace_card');
    await verifyAction(replace.agent, actionId, MFA_CODE);

    const source = await cardRow(issued.id);
    const replacementId = source.replacedByCardId;
    expect(replacementId).not.toBeNull();
    const cardsAfterReplace = await userCardCount();
    expect(cardsAfterReplace).toBe(await prisma().card.count({ where: { userId: DEMO_USER_ID } }));

    /*
     * The model-free execution path (plan nodes, confirmations, retries) re-runs the SAME authorized
     * `replace_card` execution. Replay must return the EXISTING replacement: no second card, and the
     * source's link is untouched. (A fresh MODEL-driven attempt would legitimately re-gate — the
     * gateway persists a PendingAction per tool call and has no knowledge of application idempotency;
     * that is correct behaviour, so it is deliberately not asserted here.)
     */
    const registry = createToolRegistry(DEMO_USER_ID);
    const first = await registry.executeDirect('replace_card', { cardId: issued.id });
    const second = await registry.executeDirect('replace_card', { cardId: issued.id });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((first.data as CardViewData).id).toBe(replacementId);
    expect((second.data as CardViewData).id).toBe(replacementId);
    expect((second.data as CardViewData).status).toBe('ACTIVE');
    expect((second.data as CardViewData).type).toBe('VIRTUAL');
    expect((second.data as CardViewData).linkedAccountId).toBe(ACCOUNT);
    expect((second.data as CardViewData).monthlyLimit).toBe(LIMIT_100);

    expect(await userCardCount()).toBe(cardsAfterReplace);
    expect((await cardRow(issued.id)).replacedByCardId).toBe(replacementId);
    expect((await cardRow(issued.id)).status).toBe('LOST');
    expect(await prisma().card.count({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' } })).toBe(2);
    // Replays mint no money movement either.
    expect((await cardRow(replacementId!)).linkedAccountId).toBe(ACCOUNT);
  });

  it('charges a replayed consumption once and refuses the same identity for another card', async () => {
    const virtual = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: LIMIT_100 });
    const other = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: LIMIT_100 });
    const registry = createToolRegistry(DEMO_USER_ID);

    const balanceBefore = await balanceMinor();
    const ledgerBefore = await ledgerIds();
    const consumptionsBefore = await consumptionIds();
    const args = { cardId: virtual.id, amount: '12.50', merchant: '自动扣款' };

    const first = await registry.executeDirect('consume_virtual_card', args, { idempotencyKey: EXECUTION_KEY });
    expect(first.ok).toBe(true);
    const firstData = first.data as ConsumeToolData;
    expect(firstData.consumption.amount).toBe('12.50');
    expect(moneyToCents(firstData.accountAvailableBalance)).toBe(balanceBefore - moneyToCents('12.50'));

    // The SAME execution identity (what a plan node / retry replays) never charges twice.
    const replay = await registry.executeDirect('consume_virtual_card', args, { idempotencyKey: EXECUTION_KEY });
    expect(replay.ok).toBe(true);
    expect((replay.data as ConsumeToolData).consumption.id).toBe(firstData.consumption.id);
    expect(moneyToCents((replay.data as ConsumeToolData).accountAvailableBalance)).toBe(
      balanceBefore - moneyToCents('12.50'),
    );

    expect(await balanceMinor()).toBe(balanceBefore - moneyToCents('12.50'));
    const charged = await ledgerRowsSince(ledgerBefore);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({
      channel: 'CARD',
      amountMinor: -moneyToCents('12.50'),
      accountId: ACCOUNT,
    });
    const recorded = await consumptionsSince(consumptionsBefore);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ cardId: virtual.id, amountMinor: moneyToCents('12.50'), accountId: ACCOUNT });
    expect(recorded[0].executionKey).not.toBeNull();

    /*
     * The same identity re-pointed at a DIFFERENT card is an explicit CONFLICT: an operation identity
     * belongs to one command, so a mismatched replay is refused instead of charging the second card.
     */
    const conflict = await registry.executeDirect(
      'consume_virtual_card',
      { cardId: other.id, amount: '12.50', merchant: '自动扣款' },
      { idempotencyKey: EXECUTION_KEY },
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.errorCode).toBe('CONFLICT');

    expect(await balanceMinor()).toBe(balanceBefore - moneyToCents('12.50'));
    expect(await ledgerRowsSince(ledgerBefore)).toHaveLength(1);
    expect(await consumptionsSince(consumptionsBefore)).toHaveLength(1);
    expect(await prisma().cardConsumption.count({ where: { cardId: other.id } })).toBe(0);
  });

  it('refuses every consumption when the monthly limit is 0.00', async () => {
    const sessionId = newSessionId();
    const apply = await propose(sessionId, '帮我开一张月限额 0 元的虚拟卡', 'apply_virtual_card', {
      monthlyLimit: '0.00',
    });
    const applyActionId = expectGated(apply.res, 'apply_virtual_card');
    await verifyAction(apply.agent, applyActionId, MFA_CODE);

    const [virtual] = await virtualCardRows();
    expect(virtual.monthlyLimitMinor).toBe(0n);
    expect(virtual.linkedAccountId).toBe(ACCOUNT);
    // The projection advertises exactly nothing as spendable.
    const view = (await banking.card.getCards(DEMO_USER_ID)).find((entry) => entry.id === virtual.id);
    expect(view).toBeDefined();
    expect(view!.monthlyLimit).toBe('0.00');
    expect(moneyToCents(view!.payableAmount!)).toBe(0n);

    const balanceBefore = await balanceMinor();
    const ledgerBefore = await ledgerIds();
    const consumptionsBefore = await consumptionIds();

    const attempt = await propose(sessionId, '用这张虚拟卡消费 1 元', 'consume_virtual_card', {
      cardId: virtual.id,
      amount: '1.00',
    });
    const attemptId = expectGated(attempt.res, 'consume_virtual_card');
    const denied = await verifyAction(attempt.agent, attemptId, MFA_CODE);

    expect(denied.text).toContain('限额');
    expect(await balanceMinor()).toBe(balanceBefore);
    expect(await ledgerRowsSince(ledgerBefore)).toHaveLength(0);
    expect(await consumptionsSince(consumptionsBefore)).toHaveLength(0);
    expect((await cardRow(virtual.id)).status).toBe('ACTIVE');
    // Decision consumed exactly once (see the status-semantics note in case 1); the
    // production-consistent evidence for the refusal is the `status:'failed'` audit row below.
    expect((await pendingRow(attemptId)).status).toBe('confirmed');

    const failures = (await auditRows(sessionId, 'consume_virtual_card')).filter((row) => row.status === 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ riskLevel: 'RED', mfaRequired: true, mfaResult: 'success', confirmed: true });
  });

  it('binds an absent monthly limit to available cash and never overdrafts', async () => {
    const sessionId = newSessionId();
    const apply = await propose(sessionId, '帮我开一张不设月限额的虚拟卡', 'apply_virtual_card', {});
    const applyActionId = expectGated(apply.res, 'apply_virtual_card');
    await verifyAction(apply.agent, applyActionId, MFA_CODE);

    const [virtual] = await virtualCardRows();
    expect(virtual.monthlyLimitMinor).toBeNull();
    expect(virtual.linkedAccountId).toBe(ACCOUNT);

    const cashBefore = await balanceMinor();
    // No monthly limit ⇒ payableAmount is the settlement account's cash, not a limit.
    const view = (await banking.card.getCards(DEMO_USER_ID)).find((entry) => entry.id === virtual.id);
    expect(view).toBeDefined();
    expect(view!.monthlyLimit).toBeUndefined();
    expect(moneyToCents(view!.payableAmount!)).toBe(cashBefore);
    expect(moneyToCents(view!.accountAvailableBalance!)).toBe(cashBefore);

    /* A spend within cash succeeds and debits exactly. */
    const ledgerBefore = await ledgerIds();
    const consumptionsBefore = await consumptionIds();
    const within = await propose(sessionId, '用虚拟卡消费 1000 元', 'consume_virtual_card', {
      cardId: virtual.id,
      amount: '1000.00',
      merchant: '家电卖场',
    });
    const withinId = expectGated(within.res, 'consume_virtual_card');
    await verifyAction(within.agent, withinId, MFA_CODE);

    const remaining = cashBefore - moneyToCents('1000.00');
    expect(await balanceMinor()).toBe(remaining);
    const debited = await ledgerRowsSince(ledgerBefore);
    expect(debited).toHaveLength(1);
    expect(debited[0].amountMinor).toBe(-moneyToCents('1000.00'));
    const spent = await consumptionsSince(consumptionsBefore);
    expect(spent).toHaveLength(1);
    expect(spent[0]).toMatchObject({ cardId: virtual.id, accountId: ACCOUNT, amountMinor: moneyToCents('1000.00') });

    /* One minor unit above the REMAINING cash is INSUFFICIENT_FUNDS with no partial debit. */
    const ledgerBeforeOver = await ledgerIds();
    const consumptionsBeforeOver = await consumptionIds();
    const over = await propose(sessionId, '再消费 22580.01 元', 'consume_virtual_card', {
      cardId: virtual.id,
      amount: '22580.01',
    });
    const overId = expectGated(over.res, 'consume_virtual_card');
    const denied = await verifyAction(over.agent, overId, MFA_CODE);

    expect(denied.text).toContain('余额不足');
    expect(await balanceMinor()).toBe(remaining);
    expect(await ledgerRowsSince(ledgerBeforeOver)).toHaveLength(0);
    expect(await consumptionsSince(consumptionsBeforeOver)).toHaveLength(0);
    expect((await cardRow(virtual.id)).status).toBe('ACTIVE');
    // Cash is unchanged at exactly the remaining balance — no partial debit survived the rollback.
    expect(await balanceMinor()).toBe(cashBefore - moneyToCents('1000.00'));
  });
});
