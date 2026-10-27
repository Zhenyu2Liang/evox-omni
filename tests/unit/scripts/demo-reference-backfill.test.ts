import { expect, it } from 'vitest';
import { applyReferencePlan } from '../../../scripts/demo-reference-backfill';
import { banking } from '@/banking-sdk';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();
const plan = {
  purpose: 'FICTIONAL_DEMO_REFERENCE',
  products: [{ id: 'prod_wenjiana', code: 'WJA001', expectedName: '稳健理财A', netValue: '1.1', netValueDate: '2026-09-25T00:00:00+08:00' }],
  contacts: [{ id: 'contact_zhangwei', userId: DEMO_USER_ID, expectedName: '张伟', expectedDisplay: '139****0002', phoneFull: '13900000002' }],
  cards: [{ id: 'card_credit', userId: DEMO_USER_ID, expectedType: 'CREDIT', expectedDisplay: '****6688', numberFull: '6222000000006688' }],
};
async function legacy() {
  const db = getTestPrisma();
  await db.investmentProduct.update({ where: { id: 'prod_wenjiana' }, data: { latestNetValuePerUnit: null, latestNetValueDate: null } });
  await db.contact.update({ where: { id: 'contact_zhangwei' }, data: { phoneFull: null } });
  await db.card.update({ where: { id: 'card_credit' }, data: { numberFull: null } });
  return db;
}
it('previews, applies explicit reference inputs, then replays without changing user data or funds', async () => {
  const db = await legacy();
  await db.contact.create({ data: { id: 'user-added', userId: DEMO_USER_ID, name: '新增', phone: '138****0011', phoneFull: '13800000011' } });
  const balances = await db.account.findMany(); const transactions = await db.transaction.count();
  expect((await applyReferencePlan(db, plan)).planned).toHaveLength(3);
  expect((await db.contact.findUniqueOrThrow({ where: { id: 'contact_zhangwei' } })).phoneFull).toBeNull();
  expect((await applyReferencePlan(db, plan, true)).planned).toHaveLength(3);
  expect((await applyReferencePlan(db, plan, true)).planned).toHaveLength(0);
  expect((await db.contact.findUniqueOrThrow({ where: { id: 'user-added' } })).phoneFull).toBe('13800000011');
  expect(await db.account.findMany()).toEqual(balances); expect(await db.transaction.count()).toBe(transactions);
});
it('rejects an owner or display mismatch before applying any part of the plan', async () => {
  const db = await legacy();
  await expect(applyReferencePlan(db, { ...plan, cards: [{ ...plan.cards[0], userId: 'other-user' }] }, true)).rejects.toThrow('does not match');
  expect((await db.investmentProduct.findUniqueOrThrow({ where: { id: 'prod_wenjiana' } })).latestNetValuePerUnit).toBeNull();
  expect((await db.contact.findUniqueOrThrow({ where: { id: 'contact_zhangwei' } })).phoneFull).toBeNull();
});
it('does not overwrite a complete number or accept numbers inconsistent with the visible mask', async () => {
  const db = await legacy();
  await db.contact.update({ where: { id: 'contact_zhangwei' }, data: { phoneFull: '13911110002' } });
  await expect(applyReferencePlan(db, plan, true)).rejects.toThrow('does not match');
  await expect(applyReferencePlan(db, { ...plan, contacts: [{ ...plan.contacts[0], phoneFull: '13800000003' }] }, true)).rejects.toThrow('does not match');
});
it('preserves the recorded market value while shares or net value remain unresolved', async () => {
  const db = await legacy();
  await db.investmentHolding.update({ where: { id: 'holding_wenjiana' }, data: { shares: null, estimatedMarketValue: '5178.36' } });
  const row = (await banking.investment.listHoldings(DEMO_USER_ID)).find(h => h.id === 'holding_wenjiana')!;
  expect(row.marketValue).toBe('5178.36'); expect(row.valueBasis).toBe('HISTORICAL_SNAPSHOT');
  expect(row.profit).toBeUndefined(); expect(row.cumulativeProfit).toBeUndefined();
});
