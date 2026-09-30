/**
 * GET /api/bills — bills / 账单 read model (used by the client to refresh the `/bills` page).
 *
 * Contract:
 *  - Query (validated with `billsQuerySchema`): `{ month?: string }` (`YYYY-MM`).
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
    const userId = resolveUserId(req);
    const [analysis, transactions, anomalies] = await Promise.all([
      banking.transaction.analyzeSpending(userId, { month }),
      banking.transaction.listTransactions(userId, { limit: BILLS_TRANSACTION_LIMIT }),
      banking.transaction.listAnomalies(userId),
    ]);
    const data: BillsData = { analysis, transactions, anomalies };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}
