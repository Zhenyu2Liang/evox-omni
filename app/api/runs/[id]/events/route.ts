import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { AppError } from '@/lib/errors';
import { readRunPresentation } from '@/agent/durable';
import { requireIdentity } from '../../../_lib/session';
import { errorResponse, jsonResponse, parseQuery } from '../../../_lib/http';

const querySchema = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireIdentity(request);
    const { id } = await context.params;
    const run = await prisma.agentRun.findFirst({ where: { id, ...identity } });
    if (!run) throw new AppError('NOT_FOUND', 'Agent run not found.');
    const query = parseQuery(querySchema, request);
    return jsonResponse(await readRunPresentation(id, identity.userId, query.after, query.limit));
  } catch (error) { return errorResponse(error); }
}
