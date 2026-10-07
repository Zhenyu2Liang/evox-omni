import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveManualReview } from '@/agent';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';
import type { IdRouteContext } from '../../_lib/types';

const schema = z.object({ resolution: z.enum(['stop', 'retry']), notes: z.string().trim().min(5).max(2000) }).strict();

export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const identity = await requireIdentity(req);
    const { resolution, notes } = await parseBody(schema, req);
    return jsonResponse(await resolveManualReview(identity, (await ctx.params).id, resolution, notes));
  } catch (error) { return errorResponse(error); }
}
