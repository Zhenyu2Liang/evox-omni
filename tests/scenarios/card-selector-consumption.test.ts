/**
 * Scenario — 卡片选择器在真实运行链路上生效：虚拟卡消费用「虚拟卡」/「尾号7788」执行，
 * 扣减的是该虚拟卡绑定的结算账户；把完整卡号当 cardId 则在 park 前被拒绝。
 *
 * `security/card-resolution.ts` resolves the model's SELECTOR args (`cardType`/`cardTail`/`cardNumber`)
 * into ONE owned `cardId` at park time, and `security/security-gateway.ts` canonicalizes the persisted
 * args to that id. This spec drives the REAL stack (Pi loop → registered banking tools → Security
 * Gateway `beforeToolCall` → Banking SDK → SQLite) with a scripted model, so it proves:
 *
 *   1. `{ cardType: 'VIRTUAL' }` parks a RED `consume_virtual_card` whose PERSISTED args carry ONLY the
 *      resolved `cardId` (+amount/category/merchant) — and after MFA the debit lands on the virtual
 *      card's LINKED checking account (`acct_checking`, 活期账户 ****8821): one `channel='CARD'` ledger
 *      row + one `CardConsumption` row, balance down by exactly the amount;
 *   2. `{ cardTail: '7788' }` resolves to the SAME card and debits the same account;
 *   3. a complete card number placed in the `cardId` slot is REFUSED at park time: no `PendingAction`,
 *      no MFA panel, no debit, and a plain model-readable refusal;
 *   4. neither the parked args, the confirmation summary nor the narrated result ever contains a
 *      12–19 digit run (a complete card number is server-only).
 *
 * Fixtures: demo user 李明; `acct_checking` @ ¥23,580.00; the seed ships NO virtual card, so one is
 * created here through Prisma bound to that account (shared fixtures stay untouched).
 */
import { describe, expect, it } from 'vitest';

import { MFA_CODE } from '@/lib/constants';
import { moneyToCents } from '@/lib/money';
import { ACCOUNTS, DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import { newSessionId, runTurn, toolEventsOf, verifyAction, type ScenarioResult } from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

/** 活期结算账户（¥23,580.00）— the virtual card's single funding account. */
const CHECKING = ACCOUNTS[0];
const CHECKING_ACCOUNT_ID = CHECKING.id;
/** The virtual card seeded by this spec (0000 号段, fictional). */
const VIRTUAL_ID = 'card_virtual_7788';
const VIRTUAL_MASKED = '****7788';
const VIRTUAL_FULL = '6222000000007788';
const MONTHLY_LIMIT = '500.00';
const AMOUNT = '10.00';
const USER_REQUEST = '用我的虚拟卡消费10元买咖啡';

/** Any 12–19 digit run — the shape of a COMPLETE card number that must never be emitted. */
const COMPLETE_NUMBER_SHAPE = /\d{12,19}/;

/** Every financial fact one virtual-card spend could move. */
interface LedgerFacts {
  balanceMinor: bigint;
  cardTransactions: number;
  consumptions: number;
}

async function ledgerFacts(): Promise<LedgerFacts> {
  const prisma = getTestPrisma();
  const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING_ACCOUNT_ID } });
  return {
    balanceMinor: account.balanceMinor,
    cardTransactions: await prisma.transaction.count({ where: { channel: 'CARD' } }),
    consumptions: await prisma.cardConsumption.count(),
  };
}

/** Seed the VIRTUAL card bound to the checking account. */
async function seedVirtualCard(): Promise<void> {
  await getTestPrisma().card.create({
    data: {
      id: VIRTUAL_ID,
      userId: DEMO_USER_ID,
      type: 'VIRTUAL',
      network: 'UnionPay',
      numberMasked: VIRTUAL_MASKED,
      numberFull: VIRTUAL_FULL,
      status: 'ACTIVE',
      monthlyLimitMinor: moneyToCents(MONTHLY_LIMIT),
      linkedAccountId: CHECKING_ACCOUNT_ID,
    },
  });
}

/** Drive one scripted turn whose single model step proposes `consume_virtual_card` with `args`. */
async function consumeTurn(args: Record<string, unknown>): Promise<ScenarioResult> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('consume_virtual_card', args), final('已发起虚拟卡消费。')],
  });
  return runTurn({ sessionId, message: USER_REQUEST, agent });
}

/** Park the spend through `args`, require an MFA panel, and return the action + agent for verification. */
async function parkConsume(
  args: Record<string, unknown>,
): Promise<{ res: ScenarioResult; actionId: string; agent: ReturnType<typeof buildFauxAgent> }> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('consume_virtual_card', args), final('已发起虚拟卡消费。')],
  });
  const res = await runTurn({ sessionId, message: USER_REQUEST, agent });
  expect(res.mfa).toBeDefined();
  expect(res.confirmation).toBeUndefined();
  return { res, actionId: res.mfa!.actionId, agent };
}

/** The PERSISTED args of an action. */
async function persistedArgs(actionId: string): Promise<Record<string, unknown>> {
  const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
  return JSON.parse(row.argsJson) as Record<string, unknown>;
}

describe('Scenario — 卡片选择器驱动虚拟卡消费（服务端解析 → 绑定账户扣款）', () => {
  it('{ cardType: "VIRTUAL" } → park 只含 cardId，MFA 后扣减绑定账户（余额/流水/消费记录）', async () => {
    await seedVirtualCard();
    const before = await ledgerFacts();
    expect(before.balanceMinor).toBe(moneyToCents(CHECKING.balance));

    const { res, actionId, agent } = await parkConsume({
      cardType: 'VIRTUAL',
      amount: AMOUNT,
      category: '餐饮',
      merchant: '本地咖啡店',
    });

    // The persisted args name ONE card and carry no selector leftovers.
    const expected = { cardId: VIRTUAL_ID, amount: AMOUNT, category: '餐饮', merchant: '本地咖啡店' };
    expect(await persistedArgs(actionId)).toEqual(expected);
    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.argsJson).not.toMatch(COMPLETE_NUMBER_SHAPE);
    // The persisted confirmation summary names the RESOLVED card, masked only.
    expect(row.summaryJson).toContain(VIRTUAL_MASKED);
    expect(row.summaryJson).not.toMatch(COMPLETE_NUMBER_SHAPE);
    expect(res.mfa).toBeDefined();

    const decided = await verifyAction(agent, actionId, MFA_CODE);

    // Exactly one spend: the LINKED checking account is debited, its CARD ledger row and the
    // CardConsumption row both point at that account/card.
    const after = await ledgerFacts();
    expect(after.balanceMinor).toBe(before.balanceMinor - moneyToCents(AMOUNT));
    expect(after.cardTransactions).toBe(before.cardTransactions + 1);
    expect(after.consumptions).toBe(before.consumptions + 1);

    const consumption = await getTestPrisma().cardConsumption.findFirstOrThrow({
      where: { cardId: VIRTUAL_ID },
    });
    expect(consumption.accountId).toBe(CHECKING_ACCOUNT_ID);
    expect(consumption.userId).toBe(DEMO_USER_ID);
    expect(consumption.amountMinor).toBe(moneyToCents(AMOUNT));
    expect(consumption.merchant).toBe('本地咖啡店');

    // No complete card number anywhere in what the model/UI sees.
    expect(decided.text).not.toMatch(COMPLETE_NUMBER_SHAPE);
    expect(JSON.stringify(decided.cards)).not.toMatch(COMPLETE_NUMBER_SHAPE);
    expect(decided.text).toContain(VIRTUAL_MASKED);

    expect(
      (await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status,
    ).toBe('confirmed');
  });

  it('{ cardTail: "尾号7788" } → 解析到同一张虚拟卡，扣减同一个绑定账户', async () => {
    await seedVirtualCard();
    const before = await ledgerFacts();

    const { actionId, agent } = await parkConsume({
      cardTail: '尾号7788',
      amount: AMOUNT,
      category: '餐饮',
      merchant: '本地咖啡店',
    });

    expect(await persistedArgs(actionId)).toEqual({
      cardId: VIRTUAL_ID,
      amount: AMOUNT,
      category: '餐饮',
      merchant: '本地咖啡店',
    });

    await verifyAction(agent, actionId, MFA_CODE);

    const after = await ledgerFacts();
    expect(after.balanceMinor).toBe(before.balanceMinor - moneyToCents(AMOUNT));
    expect(after.cardTransactions).toBe(before.cardTransactions + 1);
    const consumption = await getTestPrisma().cardConsumption.findFirstOrThrow({
      where: { cardId: VIRTUAL_ID },
    });
    expect(consumption.accountId).toBe(CHECKING_ACCOUNT_ID);
  });

  it('完整卡号写进 cardId → park 前被拒绝：无 PendingAction、无 MFA、零扣款', async () => {
    await seedVirtualCard();
    const before = await ledgerFacts();
    const actionsBefore = await getTestPrisma().pendingAction.count();

    const res = await consumeTurn({ cardId: VIRTUAL_FULL, amount: AMOUNT, category: '餐饮', merchant: '本地咖啡店' });

    // The model sees a PLAIN clarify refusal (not an opaque block-reason payload) and the call fails.
    const events = toolEventsOf(res, 'consume_virtual_card');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.status === 'success')).toBe(false);
    const failure = events[events.length - 1];
    expect(failure.status).toBe('error');
    expect(failure.summary).toContain('不能把尾号或卡号当作卡片 id');
    expect(res.mfa).toBeUndefined();
    expect(res.confirmation).toBeUndefined();

    // Nothing was parked, no challenge was issued, and no money moved.
    expect(await getTestPrisma().pendingAction.count()).toBe(actionsBefore);
    expect(await getTestPrisma().cardConsumption.count()).toBe(0);
    expect(await ledgerFacts()).toEqual(before);
    expect(res.text).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });
});
