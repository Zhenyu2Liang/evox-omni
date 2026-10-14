import type { NextRequest } from 'next/server';
import { cancelCardChange } from '@/security/manual-card-management';
import { requireIdentity } from '../../../../_lib/session';
import { errorResponse, jsonResponse } from '../../../../_lib/http';
import type { IdRouteContext } from '../../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try { return jsonResponse(await cancelCardChange(await requireIdentity(req), (await ctx.params).id)); }
  catch (error) { return errorResponse(error); }
}
