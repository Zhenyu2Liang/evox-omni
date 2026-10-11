/**
 * Banking SDK — dashboard read model. GREEN tier (auto-execute).
 * Aggregates account/card/transaction/anomaly data into a single summary.
 * READ-ONLY: it persists nothing and makes no permission/risk decision.
 */
import { accounts, cards } from '../lib/db/repositories';
import { demoNow } from '../lib/clock';
import { addMoney } from '../lib/money';
import { analyzeSpending, listAnomalies, listTransactions } from './transaction';
import type { DashboardSummary } from './types';
import { listHoldings } from './investment';

/** How many recent transactions the dashboard surfaces. */
const RECENT_TRANSACTION_LIMIT = 5;

/** Aggregate overview: assets, checking balance, credit available, month spend, anomalies. */
export async function getDashboardSummary(userId: string): Promise<DashboardSummary> {
  const asOf = demoNow();

  const [totalAssets, checking, cardRows, analysis, recentTransactions, anomalies] = await Promise.all([
    accounts.getTotalBalance(userId),
    accounts.getCheckingAccount(userId),
    cards.listCards(userId),
    analyzeSpending(userId),
    listTransactions(userId, { limit: RECENT_TRANSACTION_LIMIT }),
    listAnomalies(userId),
  ]);

  const creditAvailable = cardRows
    .filter((card) => card.type === 'CREDIT')
    .reduce((acc, card) => addMoney(acc, card.availableLimit ?? 0), 0);

  return {
    totalAssets: (await listHoldings(userId)).reduce((total, holding) => addMoney(total, holding.marketValue ?? holding.amount), totalAssets),
    checkingBalance: checking?.balance ?? 0,
    creditAvailable,
    monthSpend: analysis.total,
    month: analysis.month,
    recentTransactions,
    latestAnomaly: anomalies[0] ?? null,
    asOf,
  };
}
