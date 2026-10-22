/**
 * Unit: `security/security-gateway` — SERVER-SIDE card-selector resolution at PARK time.
 *
 * `gatewayCreatePendingAction` resolves `cardType` / `cardTail` / `cardNumber` (or an exact `cardId`)
 * through `security/card-resolution.ts` BEFORE anything else touches the args, and canonicalizes them
 * to the resolved `cardId`. The consequences pinned here:
 *
 *   1. a selector that resolves parks the operation with PERSISTED args that carry ONLY `cardId`
 *      (no `cardType`/`cardTail`/`cardNumber`, and no 12–19 digit run) — so the confirmation card and
 *      the Banking SDK can never name two different cards;
 *   2. an unresolvable/ambiguous/invalid selector is a plain model-readable clarification: NO
 *      `PendingAction` is created (counts before/after are equal), NO MFA challenge is issued, and the
 *      block reason is regular text (not a `BLOCK_REASON_PREFIX` payload the model cannot read);
 *   3. a tail or complete number placed in `cardId` is REFUSED (`invalid`), never re-interpreted.
 *
 * DB-backed → needs the test SQLite via `../helpers/db`. Unique `sessionId` per call so the in-process
 * circuit-breaker state never leaks between tests.
 */
import { describe, expect, it, vi } from 'vitest';

import { newId } from '@/lib/ids';
import { moneyToCents } from '@/lib/money';
import type { PendingAction } from '@/lib/contracts/security';
import type { ToolName } from '@/lib/contracts/tools';
import { BLOCK_REASON_PREFIX, securityGateway, type GatewayContext } from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/* --------------------------------------------------------------- fixture ids */

/** The seeded CREDIT card (****6688). */
const CREDIT_ID = 'card_credit';
const CREDIT_FULL = '6222000000006688';
/** The seeded DEBIT card (****8821) — the demo user's ONLY debit card. */
const DEBIT_ID = 'card_debit';
const DEBIT_MASKED = '****8821';
/** A VIRTUAL card created by this file only (the shared seed has none). */
const VIRTUAL_ID = 'card_virtual_7788';
const VIRTUAL_MASKED = '****7788';
const VIRTUAL_FULL = '6222000000007788';
const CHECKING_ACCOUNT_ID = 'acct_checking';

/** Any 12–19 digit run — the shape of a COMPLETE card number that must never be persisted/emitted. */
const COMPLETE_NUMBER_SHAPE = /\d{12,19}/;

/* ------------------------------------------------------------------ helpers */

/** A proposed call; `sessionId` is fresh so breaker state never leaks between tests. */
function ctxFor(toolName: ToolName, args: Record<string, unknown>): GatewayContext {
  return { sessionId: newId('sess'), userId: DEMO_USER_ID, toolName, args, userRequest: '演示请求' };
}

/** Park a gated call through the public wrapper (evaluate → createPendingAction). */
async function park(toolName: ToolName, args: Record<string, unknown>): Promise<PendingAction> {
  const ctx = ctxFor(toolName, args);
  return securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
}

/** Read back the PERSISTED args of an action (what the SDK will later execute). */
async function persistedArgs(actionId: string): Promise<Record<string, unknown>> {
  const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
  return JSON.parse(row.argsJson) as Record<string, unknown>;
}

/** Summary value of the given field label. */
function fieldValue(action: PendingAction, label: string): string | undefined {
  return action.summary.fields.find((field) => field.label === label)?.value;
}

/** A VIRTUAL card bound to the checking account, created directly (fixtures stay untouched). */
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
      monthlyLimitMinor: moneyToCents('500.00'),
      linkedAccountId: CHECKING_ACCOUNT_ID,
    },
  });
}

/* ============================================================ (a) 解析成功即 park */

describe('card-selector gateway · 选择器解析成功 → 只持久化 cardId', () => {
  it('set_card_limit 用 cardTail + cardType 选择器 → 持久化参数只有 cardId', async () => {
    const action = await park('set_card_limit', {
      cardType: 'CREDIT',
      cardTail: '尾号6688',
      category: '娱乐',
      amount: '3000.00',
    });

    expect(action.status).toBe('pending');
    expect(action.tier).toBe('YELLOW');

    const expected = { cardId: CREDIT_ID, category: '娱乐', amount: '3000.00' };
    expect(action.args).toEqual(expected);
    expect(await persistedArgs(action.id)).toEqual(expected);
    expect(fieldValue(action, '卡片')).toBe(`信用卡 ${'****6688'}`);
    expect(JSON.stringify(action.args)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('freeze_card 用 cardType「借记卡」→ RED awaiting_mfa，确认摘要点名同一张卡', async () => {
    const action = await park('freeze_card', { cardType: '借记卡' });

    expect(action.tier).toBe('RED');
    expect(action.requiresMfa).toBe(true);
    expect(action.status).toBe('awaiting_mfa');
    expect(action.args).toEqual({ cardId: DEBIT_ID });
    expect(await persistedArgs(action.id)).toEqual({ cardId: DEBIT_ID });
    // The confirmation card names the RESOLVED card, masked.
    expect(fieldValue(action, '卡片')).toBe(`借记卡 ${DEBIT_MASKED}`);
    expect(JSON.stringify(action.summary)).not.toMatch(COMPLETE_NUMBER_SHAPE);
    // A RED action issues exactly one code-free challenge so the UI can prompt.
    expect(await getTestPrisma().mfaChallenge.count({ where: { actionId: action.id } })).toBe(1);
  });

  it('完整卡号选择器同样规范化为 cardId（持久化行不含 12-19 位数字）', async () => {
    const action = await park('unfreeze_card', { cardNumber: CREDIT_FULL });

    expect(action.args).toEqual({ cardId: CREDIT_ID });
    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.argsJson).not.toMatch(COMPLETE_NUMBER_SHAPE);
    expect(row.argsJson).not.toContain(CREDIT_FULL);
  });

  it('consume_virtual_card 用 cardType「VIRTUAL」→ park 到该虚拟卡，金额/类别/商户原样保留', async () => {
    await seedVirtualCard();

    const action = await park('consume_virtual_card', {
      cardType: 'VIRTUAL',
      amount: '10.00',
      category: '餐饮',
      merchant: '本地咖啡店',
    });

    expect(action.tier).toBe('RED');
    expect(action.status).toBe('awaiting_mfa');
    expect(action.args).toEqual({
      cardId: VIRTUAL_ID,
      amount: '10.00',
      category: '餐饮',
      merchant: '本地咖啡店',
    });
    expect(await persistedArgs(action.id)).toEqual(action.args);
    expect(fieldValue(action, '卡片')).toBe(`虚拟卡 ${VIRTUAL_MASKED}`);
    expect(JSON.stringify(action.args)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });
});

/* ================================================== (b) 无法解析 → 澄清且不 park */

describe('card-selector gateway · 无法解析 → 澄清且不创建任何动作', () => {
  it('ambiguous（同类型第二张卡）→ DENY 纯文本澄清，无 PendingAction、无 MFA', async () => {
    await getTestPrisma().card.create({
      data: {
        id: 'card_credit_2',
        userId: DEMO_USER_ID,
        type: 'CREDIT',
        network: 'UnionPay',
        numberMasked: '****1234',
        numberFull: '6222000000001234',
        status: 'ACTIVE',
      },
    });
    const actionsBefore = await getTestPrisma().pendingAction.count();
    const challengesBefore = await getTestPrisma().mfaChallenge.count();

    const res = await securityGateway.handleToolCall(ctxFor('freeze_card', { cardType: 'CREDIT' }));

    expect(res.decision.kind).toBe('deny');
    expect(res.action).toBeUndefined();
    expect(res.blockReason).toContain('匹配到多张卡片');
    expect(res.blockReason).toContain('****6688');
    expect(res.blockReason).toContain('****1234');
    // A plain model-readable message, NOT an opaque block-reason payload.
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(false);
    expect(res.blockReason).not.toMatch(COMPLETE_NUMBER_SHAPE);

    expect(await getTestPrisma().pendingAction.count()).toBe(actionsBefore);
    expect(await getTestPrisma().mfaChallenge.count()).toBe(challengesBefore);
  });

  it('把尾号当 cardId → 明确拒绝（invalid）且不 park', async () => {
    const actionsBefore = await getTestPrisma().pendingAction.count();

    for (const cardId of ['6688', '****6688', CREDIT_FULL]) {
      const res = await securityGateway.handleToolCall(ctxFor('freeze_card', { cardId }));

      expect(res.decision.kind).toBe('deny');
      expect(res.action).toBeUndefined();
      expect(res.blockReason).toContain('不能把尾号或卡号当作卡片 id');
      expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(false);
      expect(await getTestPrisma().pendingAction.count()).toBe(actionsBefore);
    }
  });

  it('组合冲突（信用卡 + 尾号8821）→ not_found 澄清，不 park', async () => {
    const actionsBefore = await getTestPrisma().pendingAction.count();

    const res = await securityGateway.handleToolCall(
      ctxFor('set_card_limit', { cardType: 'CREDIT', cardTail: '8821', category: '娱乐', amount: '100.00' }),
    );

    expect(res.decision.kind).toBe('deny');
    expect(res.blockReason).toContain('未能找到');
    expect(await getTestPrisma().pendingAction.count()).toBe(actionsBefore);
  });
});
