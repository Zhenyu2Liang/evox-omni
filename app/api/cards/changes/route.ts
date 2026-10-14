import type { NextRequest } from 'next/server';
import { listCardChanges } from '@/security/manual-card-management';
import { requireIdentity } from '../../_lib/session';
import { errorResponse, jsonResponse } from '../../_lib/http';

export async function GET(req: NextRequest): Promise<Response> {
  try { return jsonResponse({ changes: await listCardChanges(await requireIdentity(req)) }); }
  catch (error) { return errorResponse(error); }
}
