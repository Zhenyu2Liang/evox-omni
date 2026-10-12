/**
 * GET /api/bills — bills / 账单 read model (used by the client to refresh the `/bills` page).
 *
 * Contract:
 *  - Query (validated with `billsQuerySchema`): `{ month?: string }` (`YYYY-MM`). A `?userId=` /
 *    `?sessionId=` param is IGNORED — identity is never query-trusted.
 *  - The user is the single seeded demo user, resolved SERVER-SIDE from runtime config only
 *    (`_lib/session#resolveUserId`) — the NON-AUTHORITATIVE demo-read user for these simulated-data
 *    reads. It is never used for any auth/ownership decision.
 *  - Delegates to `@/banking-sdk` (all GREEN reads):
 *      - `banking.transaction.analyzeSpending(userId, { month })` → `SpendingAnalysis`
 *      - `banking.transaction.listTransactions(userId, { limit })` → `TransactionView[]`
 *      - `banking.transaction.listAnomalies(userId)` → `AnomalyItem[]`
 *  - Success:
 *    `200 { ok: true, data: { analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] } }`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { banking, type AnomalyItem, type SpendingAnalysis, type TransactionView } from '@/banking-sdk';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { resolveUserId } from '../_lib/session';
import { monthRange } from '@/lib/date';

/** Max ledger rows surfaced in the bills table. */
const BILLS_TRANSACTION_LIMIT = 50;

/** Query schema for `GET /api/bills` (private — a Next route may only export handlers). */
const billsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM')
    .optional(),
});
export type BillsQuery = z.infer<typeof billsQuerySchema>;

/** Success payload shape for `GET /api/bills`. */
export interface BillsData {
  analysis: SpendingAnalysis;
  transactions: TransactionView[];
  anomalies: AnomalyItem[];
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const { month } = parseQuery(billsQuerySchema, req);
    const userId = resolveUserId();
    const analysis = await banking.transaction.analyzeSpending(userId, { month });
    const [year, monthNumber] = analysis.month.split('-').map(Number);
    const { start, end } = monthRange(new Date(year, monthNumber - 1, 1));
    const [transactions, allAnomalies] = await Promise.all([
      banking.transaction.listTransactions(userId, { from: start.getTime(), to: end.getTime() - 1, limit: BILLS_TRANSACTION_LIMIT }),
      banking.transaction.listAnomalies(userId),
    ]);
    const anomalies = allAnomalies.filter(item => item.transaction.occurredAt >= start.getTime() && item.transaction.occurredAt < end.getTime());
    const data: BillsData = { analysis, transactions, anomalies };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}
