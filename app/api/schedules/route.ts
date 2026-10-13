import type { NextRequest } from 'next/server';
import { getScheduleInbox } from '@/agent';
import { errorResponse, jsonResponse } from '../_lib/http';
import { requireIdentity } from '../_lib/session';

export async function GET(request: NextRequest): Promise<Response> {
  try { return jsonResponse(await getScheduleInbox(await requireIdentity(request))); }
  catch (error) { return errorResponse(error); }
}
