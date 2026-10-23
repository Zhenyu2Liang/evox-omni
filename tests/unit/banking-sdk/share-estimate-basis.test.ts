import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { multiplyDecimal, subtractDecimal } from '@/lib/decimal';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const HOLDING_ID = 'holding_wenjiana';
const PRODUCT_ID = 'prod_wenjiana';

/**
 * `valueBasis` has three producers, and only the ESTIMATE one distinguishes a backfilled holding from
 * an original purchase:
 *   - `NET_VALUE`                    — shares recorded by a real subscription (or a fixture record)
 *   - `MIGRATED_ESTIMATE`            — shares DERIVED from an old booked value by
 *                                      `scripts/investment-share-backfill.mjs`, flagged
 *                                      `sharesEstimated` (估算, never presented as exact)
 *   - `HISTORICAL_DATA_INSUFFICIENT` — no usable shares, so no valuation is invented
 * Only the flag decides between the first two: the numeric口径 (shares × net value) is identical.
 */

/** The seeded holding valued under the current product net value. */
async function holdingView() {
  const view = (await banking.investment.listHoldings(DEMO_USER_ID))
    .find((holding) => holding.id === HOLDING_ID);
  if (view === undefined) throw new Error('The seeded holding must be listed.');
  return view;
}

describe('holding value basis for backfilled (estimated) shares', () => {
  it('reports MIGRATED_ESTIMATE for shares derived from an old booked value', async () => {
    // The seeded position is exactly the backfill's output: 5000.00 cost, 5050 shares at net value 1.
    await getTestPrisma().investmentHolding.update({
      where: { id: HOLDING_ID },
      data: { sharesEstimated: true },
    });

    const view = await holdingView();
    expect(view).toMatchObject({
      amount: '5000.00',
      shares: '5050',
      latestNetValue: '1',
      marketValue: '5050',
      profit: '50',
      realizedProfit: '0.00',
      cumulativeProfit: '50',
      valueBasis: 'MIGRATED_ESTIMATE',
    });
  });

  it('keeps the same numeric口径 for an estimated holding priced above 1 CNY', async () => {
    // A fractional net value proves the estimate is still derived as shares × net value, unrounded,
    // and that profit stays market value − remaining cost (no re-pricing of the estimate itself).
    await getTestPrisma().investmentProduct.update({
      where: { id: PRODUCT_ID },
      data: { latestNetValuePerUnit: '1.2345' },
    });
    await getTestPrisma().investmentHolding.update({
      where: { id: HOLDING_ID },
      data: { shares: '1000.019876', sharesEstimated: true },
    });

    const view = await holdingView();
    const marketValue = multiplyDecimal('1000.019876', '1.2345');
    expect(view.valueBasis).toBe('MIGRATED_ESTIMATE');
    expect(view.shares).toBe('1000.019876');
    expect(view.latestNetValue).toBe('1.2345');
    expect(view.marketValue).toBe(marketValue);
    expect(view.profit).toBe(subtractDecimal(marketValue, '5000.00'));
    expect(view.cumulativeProfit).toBe(subtractDecimal(marketValue, '5000.00'));
  });

  it('reports NET_VALUE for shares recorded without the estimate flag', async () => {
    const view = await holdingView();
    expect(view).toMatchObject({ shares: '5050', valueBasis: 'NET_VALUE' });
    expect(view.profit).toBe('50');
  });

  it('preserves the historical snapshot when shares are missing, flagged or not', async () => {
    const prisma = getTestPrisma();
    await prisma.investmentHolding.update({ where: { id: HOLDING_ID }, data: { shares: null } });
    expect(await holdingView()).toMatchObject({
      amount: '5000.00',
      marketValue: '5050',
      valueBasis: 'HISTORICAL_SNAPSHOT',
    });

    // The flag alone can never value a position: no shares means no estimate is invented.
    await prisma.investmentHolding.update({ where: { id: HOLDING_ID }, data: { sharesEstimated: true } });
    const flagged = await holdingView();
    expect(flagged).toMatchObject({
      marketValue: '5050',
      valueBasis: 'HISTORICAL_SNAPSHOT',
    });
    expect(flagged.shares).toBeUndefined();
    expect(flagged.profit).toBeUndefined();
  });

  it('uses cost only when neither shares nor a valid historical estimate is available', async () => {
    const prisma = getTestPrisma();
    await prisma.investmentHolding.update({ where: { id: HOLDING_ID }, data: { shares: null, estimatedMarketValue: null } });
    expect(await holdingView()).toMatchObject({ marketValue: '5000.00', valueBasis: 'HISTORICAL_DATA_INSUFFICIENT' });
  });
});
