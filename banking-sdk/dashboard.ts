/**
 * Banking SDK — dashboard read model. GREEN tier (auto-execute).
 * Aggregates account/card/transaction/anomaly data into a single summary.
 * READ-ONLY: it persists nothing and makes no permission/risk decision.
 */
import { accounts, cards } from '../lib/db/repositories';
import { demoNow } from '../lib/clock';
import { centsToMoney } from '../lib/money';
import { addDecimal } from '../lib/decimal';
import { analyzeSpending, listAnomalies, listTransactions } from './transaction';
import type { DashboardSummary } from './types';
import { listHoldings } from './investment';
import { runInTransaction } from './tx';

/** How many recent transactions the dashboard surfaces. */
const RECENT_TRANSACTION_LIMIT = 5;

/** Aggregate overview: assets, checking balance, credit available, month spend, anomalies. */
export async function getDashboardSummary(userId: string): Promise<DashboardSummary> {
  const asOf = demoNow();

  return runInTransaction(async () => {
  const [totalAssets, checking, cardRows, analysis, recentTransactions, anomalies, holdings] = await Promise.all([
    accounts.getTotalBalance(userId),
    accounts.getCheckingAccount(userId),
    cards.listCards(userId),
    analyzeSpending(userId),
    listTransactions(userId, { limit: RECENT_TRANSACTION_LIMIT }),
    listAnomalies(userId),
    listHoldings(userId),
  ]);

  // Only UNREPLACED credit counts. `replaceCard` leaves the `LOST` source card (with its
  // `availableLimitMinor` intact) pointing at the NEW card that inherits that same limit, so summing
  // every `CREDIT` row would report the same credit twice and inflate the total.
  const creditAvailable = cardRows
    .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST')
    .reduce((total, card) => total + (card.availableLimitMinor ?? 0n), 0n);

  return {
    totalAssets: holdings.reduce((total, holding) => addDecimal(total, holding.marketValue ?? holding.amount), centsToMoney(totalAssets)),
    checkingBalance: centsToMoney(checking?.balanceMinor ?? 0n),
    creditAvailable: centsToMoney(creditAvailable),
    monthSpend: analysis.total,
    month: analysis.month,
    recentTransactions,
    latestAnomaly: anomalies[0] ?? null,
    asOf,
  };
  });
}
