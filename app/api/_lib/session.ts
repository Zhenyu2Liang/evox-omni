import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { DEFAULT_DEMO_USER_ID } from '@/lib/constants';
import { getDemoSession } from '@/agent/session';
import { assertSameOriginWrite } from './http';

/** The only Web identity comes from trusted server configuration, never a browser parameter. */
export function resolveUserId(): string {
  return getConfig().demoUserId || DEFAULT_DEMO_USER_ID;
}

export interface RequestIdentity {
  sessionId: string;
  userId: string;
}

/** This simulator has one shared workspace; cookies, query parameters and login are unnecessary. */
export async function resolveIdentity(_req?: NextRequest): Promise<RequestIdentity> {
  const snapshot = await getDemoSession(resolveUserId());
  return { sessionId: snapshot.sessionId, userId: snapshot.userId };
}

/** Keep resource ownership, authorization and execution fences downstream of the demo identity. */
export async function requireIdentity(req?: NextRequest): Promise<RequestIdentity> {
  if (req) assertSameOriginWrite(req);
  return resolveIdentity(req);
}
