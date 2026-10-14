import type { NextRequest } from 'next/server';
import { deleteDemoCardSchema, proposeCardChange } from '@/security/manual-card-management';
import { requireIdentity } from '../../_lib/session';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import type { IdRouteContext } from '../../_lib/types';

export async function DELETE(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const input = await parseBody(deleteDemoCardSchema, req);
    return jsonResponse(await proposeCardChange(await requireIdentity(req), { ...input, cardId: (await ctx.params).id }));
  } catch (error) { return errorResponse(error); }
}
