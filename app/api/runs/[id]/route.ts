import type { NextRequest } from 'next/server';
import { getOwnedRunSummary } from '@/agent/durable/service';
import { errorResponse, jsonResponse } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';
import type { IdRouteContext } from '../../_lib/types';

/** Return metadata for exactly the cookie-owned run; raw model events remain internal. */
export async function GET(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const identity = await requireIdentity(req);
    return jsonResponse(await getOwnedRunSummary((await ctx.params).id, identity));
  } catch (error) { return errorResponse(error); }
}
