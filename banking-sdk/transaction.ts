/**
 * Banking SDK — transaction reads & analysis. GREEN tier (auto-execute).
 * Spend analysis / anomaly detection read `Transaction` rows; `detectAnomaly` may persist
 * anomaly flags via `lib/db/repositories`.
 */
import type {
  AnomalyItem,
  AnomalyReport,
  SpendingAnalysis,
  SpendingQuery,
  TransactionQuery,
  TransactionView,
} from './types';

/** Transactions for the user, filtered by the query, most recent first. */
export async function listTransactions(
  userId: string,
  query: TransactionQuery = {},
): Promise<TransactionView[]> {
  throw new Error('not implemented');
}

/** Spending breakdown for a month (defaults to the current month). */
export async function analyzeSpending(
  userId: string,
  query: SpendingQuery = {},
): Promise<SpendingAnalysis> {
  throw new Error('not implemented');
}

/** Scan transactions for anomalies (large/irregular spends) and return a report. */
export async function detectAnomaly(userId: string): Promise<AnomalyReport> {
  throw new Error('not implemented');
}

/** Previously flagged anomalies for the user (rows with `isAnomaly = true`). */
export async function listAnomalies(userId: string): Promise<AnomalyItem[]> {
  throw new Error('not implemented');
}
