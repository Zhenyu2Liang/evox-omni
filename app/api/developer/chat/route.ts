import type { NextRequest } from 'next/server';
import { getDemoSession } from '@/agent/session';
import { requireIdentity } from '../../_lib/session';
import { requireDeveloperMode } from '../../_lib/developer';
import { errorResponse, jsonResponse } from '../../_lib/http';

export async function GET(request: NextRequest): Promise<Response> {
  try {
    requireDeveloperMode(request);
    const identity = await requireIdentity(request);
    const snapshot = await getDemoSession(identity.userId);
    return jsonResponse({ revision: snapshot.revision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
