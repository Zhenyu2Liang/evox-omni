import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { requireIdentity } from '../_lib/session';
import { errorResponse, jsonResponse } from '../_lib/http';

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const identity = await requireIdentity(request);
    const runs = await prisma.agentRun.findMany({ where: identity, orderBy: { startedAt: 'desc' }, take: 50,
      select: { id: true, status: true, startedAt: true, finishedAt: true, errorCode: true,
        nextSequence: true, _count: { select: { invocations: true } } } });
    return jsonResponse({ runs });
  } catch (error) { return errorResponse(error); }
}
