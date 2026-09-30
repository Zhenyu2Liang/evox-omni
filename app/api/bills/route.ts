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
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { banking, type SpendingAnalysis, type TransactionView, type AnomalyItem } from '@/banking-sdk';

/** Query schema for `GET /api/bills`. */
export const billsQuerySchema = z.object({
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

export async function GET(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void banking;
