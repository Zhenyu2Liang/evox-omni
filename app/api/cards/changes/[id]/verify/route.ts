import type { NextRequest } from 'next/server';
import { verifyCardChange, verifyCardChangeSchema } from '@/security/manual-card-management';
import { requireIdentity } from '../../../../_lib/session';
import { errorResponse, jsonResponse, parseBody } from '../../../../_lib/http';
import type { IdRouteContext } from '../../../../_lib/types';

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const { code } = await parseBody(verifyCardChangeSchema, req);
    return jsonResponse(await verifyCardChange(await requireIdentity(req), (await ctx.params).id, code));
  } catch (error) { return errorResponse(error); }
}
