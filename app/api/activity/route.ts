import type { NextRequest } from 'next/server';
import { listOperationHistory } from '@/audit';
import { errorResponse, jsonResponse, parseQuery } from '../_lib/http';
import { limitQuerySchema } from '../_lib/schemas';
import { requireIdentity } from '../_lib/session';

/** Public business events; identity hints never select another demo workspace. */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const query = parseQuery(limitQuerySchema, request);
    const identity = await requireIdentity(request);
    const entries = await listOperationHistory({ ...identity, limit: query.limit });
    return jsonResponse({ entries });
  } catch (error) {
    return errorResponse(error);
  }
}
