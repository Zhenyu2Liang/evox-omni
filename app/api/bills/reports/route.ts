import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { banking, type BillReportQuery } from '@/banking-sdk';
import { billReportCsv, billReportHtml } from '@/lib/bill-report-export';
import { billReportPdf } from '@/lib/bill-report-pdf';
import { readBillReportAnalysis } from '@/agent/bill-report-analysis';
import { AppError } from '@/lib/errors';
import { assertSameOriginWrite, errorResponse, jsonResponse } from '../../_lib/http';
import { resolveUserId } from '../../_lib/session';

const optionsSchema = z.strictObject({ format: z.enum(['json', 'csv', 'html', 'pdf']).default('json'), locale: z.enum(['zh-CN', 'en']).default('zh-CN') });
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    assertSameOriginWrite(req);
    const params = req.nextUrl.searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new AppError('VALIDATION', 'Repeated report parameters are not supported.');
    const { format: formatParam, locale, ...query } = Object.fromEntries(params);
    const options = optionsSchema.safeParse({ format: formatParam, locale });
    if (!options.success) throw new AppError('VALIDATION', 'Choose json, csv, html or pdf and a supported language.');
    const report = await banking.report.getBillReport(resolveUserId(), query as BillReportQuery);
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (options.data.format === 'json') return jsonResponse(report, { headers });
    const format = options.data.format;
    const analysis = format === 'csv' ? null : await readBillReportAnalysis(resolveUserId(), report, options.data.locale);
    const document = format === 'csv' ? '' : billReportHtml(report, options.data.locale, analysis);
    const body = format === 'pdf' ? await billReportPdf(document) : format === 'html' ? document : billReportCsv(report, options.data.locale);
    return new Response(body, {
      headers: { ...headers, 'Content-Type': format === 'pdf' ? 'application/pdf' : format === 'html' ? 'text/html; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="bill-report-${report.label}.${format}"`,
        ...(format === 'html' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox" } : {}) },
    });
  } catch (error) { return errorResponse(error); }
}
