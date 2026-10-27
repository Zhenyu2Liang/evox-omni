import { expect, it } from 'vitest';
import { getOrCreateSession, verifyAction } from '@/agent';
import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { runRedeemInvestment } from '@/agent/tools/investment';
import { security } from '@/security';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

for (const args of [{ mode: 'SHARES', shares: '100' }, { mode: 'AMOUNT', amount: '100.00' }]) {
  it(`${args.mode}: rejects the parked redemption after an additional purchase`, async () => {
    const db = getTestPrisma();
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const parked = await security.gateway.securityGateway.handleToolCall({
      sessionId, userId: DEMO_USER_ID, toolName: 'redeem_investment',
      args: { holdingId: 'holding_wenjiana', ...args }, userRequest: '部分赎回理财',
    });
    expect(parked.action).toBeDefined();
    await banking.investment.subscribeInvestment({ userId: DEMO_USER_ID,
      productId: 'prod_wenjiana', amount: '1000.00', idempotencyKey: 'position-purchase' });
    const before = await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    const position = await db.investmentHolding.findUniqueOrThrow({ where: { id: 'holding_wenjiana' } });
    const ledgerCount = await db.transaction.count();
    const outcome = await verifyAction(parked.action!.id, MFA_CODE);
    expect(outcome.ok).toBe(false);
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: parked.action!.id } })).status).toBe('failed');
    expect((await db.account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
    expect(await db.investmentHolding.findUniqueOrThrow({ where: { id: position.id } })).toEqual(position);
    expect(await db.transaction.count()).toBe(ledgerCount);
  });
}

it('replays a committed redemption after later position changes without another credit', async () => {
  const db = getTestPrisma();
  const input = { userId: DEMO_USER_ID, holdingId: 'holding_wenjiana', mode: 'SHARES' as const,
    shares: '100', expectedPositionVersion: 0, idempotencyKey: 'original-receipt' };
  const first = await banking.investment.redeemInvestment(input);
  await banking.investment.subscribeInvestment({ userId: DEMO_USER_ID,
    productId: 'prod_wenjiana', amount: '1000.00', idempotencyKey: 'later-purchase' });
  const before = await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
  expect(await banking.investment.redeemInvestment(input)).toEqual(first);
  expect((await db.account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
});

it('requires a new decision for pre-upgrade authorized executions missing a position version', async () => {
  const result = await runRedeemInvestment(DEMO_USER_ID,
    { holdingId: 'holding_wenjiana', mode: 'SHARES', shares: '100', expectedShares: '100' },
    { idempotencyKey: 'old-decision', fence: async () => {} });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('持仓授权缺少版本');
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
});
