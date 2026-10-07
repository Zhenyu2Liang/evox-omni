import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getManualReviewInbox, openManualReview } from '@/agent';
import { errorResponse, jsonResponse, parseBody } from '../_lib/http';
import { requireIdentity } from '../_lib/session';

const schema = z.object({
  taskId: z.string().min(1).optional(), actionId: z.string().min(1).optional(),
  reason: z.string().trim().min(5).max(1000),
}).strict().refine((v) => Boolean(v.taskId) !== Boolean(v.actionId), 'Specify exactly one target');

export async function GET(req: NextRequest): Promise<Response> {
  try { return jsonResponse(await getManualReviewInbox(await requireIdentity(req))); }
  catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const identity = await requireIdentity(req);
    const { reason, ...target } = await parseBody(schema, req);
    return jsonResponse(await openManualReview(identity, target, reason));
  } catch (error) { return errorResponse(error); }
}
