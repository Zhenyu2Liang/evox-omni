import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { banking, type BillReportQuery } from '@/banking-sdk';
import { generateBillReportAnalysis } from '@/agent/bill-report-analysis';
import { parseBody, errorResponse, jsonResponse } from '../../../_lib/http';
import { resolveUserId } from '../../../_lib/session';

const schema = z.strictObject({ query: z.unknown(), locale: z.enum(['zh-CN', 'en']) });
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = await parseBody(schema, req);
    const userId = resolveUserId();
    const report = await banking.report.getBillReport(userId, body.query as BillReportQuery);
    const analysis = await generateBillReportAnalysis(userId, report, body.locale, req.signal);
    return jsonResponse(analysis, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}
