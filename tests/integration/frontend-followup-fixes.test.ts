import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { banking } from '@/banking-sdk';
import { addDemoCardSchema, proposeCardChange, verifyCardChange } from '@/security/manual-card-management';
import CardChangeDialog from '@/app/cards/CardChangeDialog';
import { runRedeemInvestment } from '@/agent/tools/investment';
import { getDemoSession, newSession, saveSession } from '@/agent/session';
import { resolveBankingArgs } from '@/lib/banking-selectors';
import { securityGateway as gateway } from '@/security/security-gateway';
import { verify } from '@/security/mfa';
import { isLocked, resetSession } from '@/security/circuit-breaker';
import { securityEventStore } from '@/audit/security-events';
import { MfaCard } from '@/components/chat/cards/MfaCard';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import type { ToolName } from '@/lib/contracts/tools';
import { DEFAULT_LOCALE, translate } from '@/lib/i18n/shared';

beforeEach(resetDatabase);
const db = getTestPrisma;

async function park(toolName: ToolName, args: Record<string, unknown>, userId = DEMO_USER_ID) {
  const snapshot = newSession(userId);
  await saveSession(snapshot);
  const response = await gateway.handleToolCall({ sessionId: snapshot.sessionId, userId, toolName, args, userRequest: `验证 ${toolName}` });
  if (!response.action) throw new Error('Expected a persisted decision card');
  return { action: response.action, sessionId: snapshot.sessionId, userId };
}

async function exhaust(actionId: string) {
  for (let attempt = 0; attempt < 3; attempt++) await verify(actionId, '000000');
}

describe('frontend follow-up: manually reviewed demo card configuration', () => {
  it('discloses and persists the confirmed monthly limit, including replay', async () => {
    const identity = { userId: DEMO_USER_ID, sessionId: (await getDemoSession(DEMO_USER_ID)).sessionId };
    const request = { requestId: '9c667789-b56b-463e-801a-81d3e65219bd', type: 'VIRTUAL' as const, monthlyLimit: '2000.50' };
    const proposed = await proposeCardChange(identity, request);
    expect(proposed.change).toMatchObject({ status: 'pending', requiresMfa: true, monthlyLimit: '2000.50' });
    const html = renderToStaticMarkup(createElement(CardChangeDialog, { selection: { kind: 'change', change: proposed.change }, busy: false,
      onClose() {}, onPrepareAdd() {}, onPrepareDelete() {}, onVerify() {}, onCancel() {} }));
    expect(html).toContain(translate(DEFAULT_LOCALE, 'business.cards.monthlyLimit'));
    expect(html).toContain('¥2,000.50');
    const first = await verifyCardChange(identity, proposed.change.id, '123456');
    const second = await verifyCardChange(identity, proposed.change.id, '123456');
    expect(first.ok).toBe(true); expect(second.change.card).toEqual(first.change.card);
    const rows = await db().card.findMany({ where: { type: 'VIRTUAL' } });
    expect(rows).toHaveLength(1); expect(rows[0].monthlyLimitMinor).toBe(200050n);
    await expect(proposeCardChange(identity, { ...request, monthlyLimit: '9999.00' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await db().card.findUniqueOrThrow({ where: { id: rows[0].id } })).monthlyLimitMinor).toBe(200050n);
  });
  it('creates a card without inventing a monthly limit when none was configured', async () => {
    const identity = { userId: DEMO_USER_ID, sessionId: (await getDemoSession(DEMO_USER_ID)).sessionId };
    const proposed = await proposeCardChange(identity, { requestId: '05f2d3f5-f5a2-48aa-bd70-058fcf5cf4ea', type: 'VIRTUAL' });
    expect(proposed.change.monthlyLimit).toBeUndefined();
    const result = await verifyCardChange(identity, proposed.change.id, '123456');
    expect(result.ok).toBe(true); expect(result.change.card?.monthlyLimit).toBeUndefined();
    expect((await db().card.findFirstOrThrow({ where: { type: 'VIRTUAL' } })).monthlyLimitMinor).toBeNull();
  });
  it.each(['-1', '1.001', 'Infinity'])('rejects invalid limit %s before issuing a card', async monthlyLimit => {
    expect(() => addDemoCardSchema.parse({ requestId: 'ecc5986c-393f-43b8-9903-39fc5a39c0e5', type: 'VIRTUAL', monthlyLimit })).toThrow();
    await expect(banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit })).rejects.toThrow();
    expect(await db().card.count({ where: { type: 'VIRTUAL' } })).toBe(0);
  });
});

describe('frontend follow-up: redemption scope and selectors', () => {
  it('resolves an exact owned holding ID and rejects product names or codes', async () => {
    expect((await resolveBankingArgs(DEMO_USER_ID, 'redeem_investment', { holdingId: 'holding_wenjiana' })).holdingId).toBe('holding_wenjiana');
    await expect(resolveBankingArgs(DEMO_USER_ID, 'redeem_investment', { holdingId: 'WJA001' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveBankingArgs('other-owner', 'redeem_investment', { holdingId: 'holding_wenjiana' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rejects product names in the holding ID field; historical IDs remain available for safe replay', async () => {
    await db().investmentHolding.create({ data: { userId: DEMO_USER_ID, productId: 'prod_wenjiana', principalAmountMinor: 100000n, status: 'HOLDING' } });
    await expect(resolveBankingArgs(DEMO_USER_ID, 'redeem_investment', { holdingId: '稳健理财A' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db().investmentHolding.updateMany({ data: { status: 'REDEEMED' } });
    await expect(resolveBankingArgs(DEMO_USER_ID, 'redeem_investment', { holdingId: '稳健理财A' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await resolveBankingArgs(DEMO_USER_ID, 'redeem_investment', { holdingId: 'holding_wenjiana' })).holdingId).toBe('holding_wenjiana');
  });
  it('shows full market-value redemption in the MFA card and credits that exact amount once', async () => {
    const { action } = await park('redeem_investment', { holdingId: 'holding_wenjiana', expectedRedemptionAmount: '1.00' });
    expect(action.args.expectedRedemptionAmount).toBe('5050.00'); // Supplied model value never wins.
    const html = renderToStaticMarkup(createElement(MfaCard, { actionId: action.id, action: action.summary }));
    expect(html).toContain('全部赎回'); expect(html).toContain(translate(DEFAULT_LOCALE, 'chat.field.principal'));
    expect(html).toContain('¥5,000.00'); expect(html).toContain('¥5,050.00');
    const result = await runRedeemInvestment(DEMO_USER_ID, action.args, { idempotencyKey: action.id });
    const replay = await runRedeemInvestment(DEMO_USER_ID, action.args, { idempotencyKey: action.id });
    expect(result.ok).toBe(true); expect(replay.data).toEqual(result.data);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2863000n);
    expect(await db().transaction.count({ where: { category: '投资', direction: 'CREDIT' } })).toBe(1);
  });
  it('rejects a changed value without closing the holding or moving funds', async () => {
    const { action } = await park('redeem_investment', { holdingId: 'holding_wenjiana' });
    await db().investmentHolding.update({ where: { id: 'holding_wenjiana' }, data: { estimatedMarketValue: '5060' } });
    const before = await db().transaction.count();
    const result = await runRedeemInvestment(DEMO_USER_ID, action.args, { idempotencyKey: action.id });
    expect(result.ok).toBe(false); expect(result.errorCode).toBe('CONFLICT');
    expect(result.error).toContain('赎回金额已变化，需要重新确认。');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    expect((await db().investmentHolding.findUniqueOrThrow({ where: { id: 'holding_wenjiana' } })).status).toBe('HOLDING');
    expect(await db().transaction.count()).toBe(before);
  });
  it('binds the same rounded settlement in the approval card, execution and original receipt', async () => {
    await db().investmentHolding.update({ where: { id: 'holding_wenjiana' }, data: { estimatedMarketValue: '5050.005' } });
    const { action } = await park('redeem_investment', { holdingId: 'holding_wenjiana' });
    expect(action.args.expectedRedemptionAmount).toBe('5050.01');
    const html = renderToStaticMarkup(createElement(MfaCard, { actionId: action.id, action: action.summary }));
    expect(html).toContain('¥5,050.01');
    const result = await runRedeemInvestment(DEMO_USER_ID, action.args, { idempotencyKey: action.id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ amount: '5050.01', redemptionValuation: '5050.005', settlementRounding: 'HALF_UP' });
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2863001n);
  });
  it('reuses a plan decision with its original quote instead of silently authorizing a changed value', async () => {
    const snapshot = newSession(DEMO_USER_ID); await saveSession(snapshot);
    const task = await db().agentTask.create({ data: { sessionId: snapshot.sessionId, userId: DEMO_USER_ID, goal: '赎回', status: 'pending' } });
    const request = { sessionId: snapshot.sessionId, userId: DEMO_USER_ID, toolName: 'redeem_investment' as const,
      taskId: task.id, nodeId: 'redeem', args: { holdingId: 'holding_wenjiana' }, userRequest: '赎回稳健理财A' };
    const first = await gateway.handleToolCall(request);
    await db().investmentHolding.update({ where: { id: 'holding_wenjiana' }, data: { estimatedMarketValue: '5060' } });
    const replay = await gateway.handleToolCall(request);
    expect(replay.action?.id).toBe(first.action?.id);
    expect(replay.action?.args.expectedRedemptionAmount).toBe('5050.00');
    expect(await db().pendingAction.count({ where: { taskId: task.id } })).toBe(1);
  });
});

describe('frontend follow-up: unlock resumes undecided MFA challenges', () => {
  it('wrong reset cannot renew; audited unlock renews but does not execute the old action', async () => {
    const { action, sessionId } = await park('report_lost_card', { cardId: 'card_debit' });
    await exhaust(action.id);
    await expect(resetSession(sessionId, { verificationCode: '111111' })).rejects.toThrow();
    expect((await db().mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } })).status).toBe('locked');
    await resetSession(sessionId, { verificationCode: '123456' });
    expect(await isLocked(sessionId)).toBe(false);
    expect(await db().mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } })).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await db().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('awaiting_mfa');
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_debit' } })).status).toBe('ACTIVE');
    expect(await verify(action.id, '000000')).toMatchObject({ ok: true, value: { ok: false, locked: false, attemptsLeft: 2 } });
    expect(await verify(action.id, '123456')).toMatchObject({ ok: true, value: { ok: true, locked: false } });
    const events = await db().securityEvent.findMany({ where: { kind: 'SECURITY_RESET' } });
    expect(events).toHaveLength(1); expect(JSON.parse(events[0].detail!)).toMatchObject({ renewedMfaChallenges: 1 });
  });
  it('renewal is owner-scoped and excludes settled or cancelled actions', async () => {
    const first = await park('report_lost_card', { cardId: 'card_debit' });
    const second = await park('unfreeze_card', { cardId: 'card_credit' });
    const cancelled = await park('freeze_card', { cardId: 'card_credit' });
    await db().user.create({ data: { id: 'other', name: '其他用户', phone: '13999998888' } });
    await db().card.create({ data: { id: 'other-card', userId: 'other', type: 'DEBIT', network: 'UnionPay', numberMasked: '****9900', status: 'ACTIVE' } });
    const foreign = await park('freeze_card', { cardId: 'other-card' }, 'other');
    await db().mfaChallenge.updateMany({ data: { status: 'locked', attempts: 3 } });
    await db().pendingAction.update({ where: { id: cancelled.action.id }, data: { status: 'cancelled' } });
    await db().circuitBreakerState.create({ data: { key: `user:${DEMO_USER_ID}`, userId: DEMO_USER_ID, locked: true, failures: 3, lockedAt: new Date() } });
    await resetSession(first.sessionId, { verificationCode: '123456' });
    for (const id of [first.action.id, second.action.id]) expect((await db().mfaChallenge.findUniqueOrThrow({ where: { actionId: id } })).status).toBe('pending');
    for (const id of [cancelled.action.id, foreign.action.id]) expect((await db().mfaChallenge.findUniqueOrThrow({ where: { actionId: id } })).status).toBe('locked');
  });
  it('an audit failure rolls back both account unlock and challenge renewal', async () => {
    const { action, sessionId } = await park('freeze_card', { cardId: 'card_debit' });
    await exhaust(action.id);
    const spy = vi.spyOn(securityEventStore, 'insertSecurityEvent').mockRejectedValueOnce(new Error('reset audit failed'));
    try { await expect(resetSession(sessionId, { verificationCode: '123456' })).rejects.toThrow('reset audit failed'); }
    finally { spy.mockRestore(); }
    expect(await isLocked(sessionId)).toBe(true);
    expect(await db().mfaChallenge.findUniqueOrThrow({ where: { actionId: action.id } })).toMatchObject({ status: 'locked', attempts: 3 });
  });
});
