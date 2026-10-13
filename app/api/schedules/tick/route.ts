import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { tickScheduledTasks } from '@/agent';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const identity = await requireIdentity(request);
    await parseBody(z.object({}).strict(), request);
    return jsonResponse(await tickScheduledTasks(identity));
  } catch (error) { return errorResponse(error); }
}
