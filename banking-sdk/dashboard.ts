/**
 * Banking SDK — dashboard read model. GREEN tier (auto-execute).
 * Aggregates account/card/transaction/anomaly data into a single summary.
 */
import type { DashboardSummary } from './types';

/** Aggregate overview: assets, checking balance, credit available, month spend, anomalies. */
export async function getDashboardSummary(userId: string): Promise<DashboardSummary> {
  throw new Error('not implemented');
}
