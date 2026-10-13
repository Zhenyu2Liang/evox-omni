import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { recoverOwnedRun } from '@/agent/durable/service';
import { errorResponse, jsonResponse, parseOptionalBody } from '../../../_lib/http';
import { requireIdentity } from '../../../_lib/session';
import type { IdRouteContext } from '../../../_lib/types';

const recoveryRequest = z.object({ invocationId: z.string().min(1).optional() }).strict();

/** Explicitly recover original facts or retry a read; this endpoint cannot authorize writes. */
export async function POST(req: NextRequest, ctx: IdRouteContext): Promise<Response> {
  try {
    const identity = await requireIdentity(req);
    const body = await parseOptionalBody(recoveryRequest, req);
    return jsonResponse(await recoverOwnedRun((await ctx.params).id, identity, body.invocationId));
  } catch (error) { return errorResponse(error); }
}
