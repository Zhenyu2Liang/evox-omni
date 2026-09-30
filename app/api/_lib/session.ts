/**
 * app/api/_lib/session.ts — resolves the demo user and agent session for a request.
 *
 * The demo runs a single seeded user (李明) and one agent session per browser. The user id comes
 * from runtime config (`getConfig().demoUserId`, defaulting to `DEFAULT_DEMO_USER_ID`); the
 * session id comes from the `banking_session` cookie (`SESSION_COOKIE`) set on the first
 * `POST /api/chat` turn. Read routes may override either via a query param.
 */
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { DEFAULT_DEMO_USER_ID, SESSION_COOKIE } from '@/lib/constants';

/**
 * Resolve the demo user id for a request.
 * Precedence: `?userId=` query param → `getConfig().demoUserId` → `DEFAULT_DEMO_USER_ID`.
 */
export function resolveUserId(req?: NextRequest): string {
  const fromQuery = req ? new URL(req.url).searchParams.get('userId') : null;
  return fromQuery || getConfig().demoUserId || DEFAULT_DEMO_USER_ID;
}

/**
 * Resolve the agent session id for a request, or `undefined` when none exists yet.
 * Precedence: `?sessionId=` query param → the `banking_session` cookie.
 */
export function resolveSessionId(req?: NextRequest): string | undefined {
  if (!req) return undefined;
  const fromQuery = new URL(req.url).searchParams.get('sessionId');
  if (fromQuery) return fromQuery;
  return req.cookies.get(SESSION_COOKIE)?.value ?? undefined;
}
