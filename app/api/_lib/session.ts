/**
 * app/api/_lib/session.ts — resolves the TRUSTED request identity (demo user + agent session).
 *
 * The demo runs a single seeded user (李明) and one agent session per browser. Identity is
 * TRUSTED, SERVER-SIDE data:
 *  - The session id comes ONLY from the HttpOnly `banking_session` cookie (`SESSION_COOKIE`, set
 *    by `POST /api/chat`). Any `?sessionId=` query param is IGNORED for every authorization/write
 *    decision — a query param must NEVER forge, override or widen identity.
 *  - The user id is read SERVER-SIDE from the owning `AgentSession` row (`resolveIdentity`), never
 *    from a client-supplied `?userId=`.
 *
 * The four GREEN read routes (`dashboard`/`bills`/`cards`/`subscriptions`) render the single seeded
 * demo user's SIMULATED data for the screens to display; they resolve that NON-AUTHORITATIVE
 * demo-read user from runtime config only (`resolveUserId()`), with no query override. That value is
 * NOT an authorization primitive — callers must not use it for any auth/ownership/write decision.
 */
import type { NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { DEFAULT_DEMO_USER_ID, SESSION_COOKIE } from '@/lib/constants';
import { getSession } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';

/**
 * Resolve the NON-AUTHORITATIVE demo-read user id from runtime config only.
 *
 * Used SOLELY by the GREEN read routes that surface the single seeded demo user's simulated data
 * (the demo has no multi-user auth). It MUST NOT be used for any auth/ownership/write decision —
 * those use `resolveIdentity`, whose user id is read server-side from the owning session row.
 * Precedence: `getConfig().demoUserId` → `DEFAULT_DEMO_USER_ID`. No `?userId=` override.
 */
export function resolveUserId(): string {
  return getConfig().demoUserId || DEFAULT_DEMO_USER_ID;
}

/**
 * Resolve the agent session id for a request from the `banking_session` cookie.
 * Returns `undefined` when the cookie is absent. Any `?sessionId=` query param is IGNORED.
 */
export function resolveSessionId(req?: NextRequest): string | undefined {
  if (!req) return undefined;
  return req.cookies.get(SESSION_COOKIE)?.value ?? undefined;
}

/** Trusted, server-derived request identity (never sourced from a query param). */
export interface RequestIdentity {
  sessionId: string;
  userId: string;
}

/**
 * Resolve the TRUSTED request identity from the `banking_session` cookie.
 *
 * Returns `null` when the cookie is missing OR the cookie's session id does not match a persisted
 * `AgentSession` row. The user id is read SERVER-SIDE from that row — a query param can never
 * override or forge identity. Callers that require an authenticated request treat `null` as
 * `403 SECURITY_DENIED`.
 */
export async function resolveIdentity(req?: NextRequest): Promise<RequestIdentity | null> {
  const sessionId = resolveSessionId(req);
  if (!sessionId) return null;
  const row = await getSession(sessionId);
  if (!row) return null;
  return { sessionId: row.id, userId: row.userId };
}

/**
 * Resolve the TRUSTED request identity or reject the request with `403 SECURITY_DENIED`.
 *
 * Shared by every handler that needs an authenticated caller (the action + task-control + breaker
 * routes): a missing cookie or an unknown session both fail closed.
 */
export async function requireIdentity(req?: NextRequest): Promise<RequestIdentity> {
  const identity = await resolveIdentity(req);
  if (!identity) {
    throw new AppError('SECURITY_DENIED', '无法验证身份，请重新开始会话。');
  }
  return identity;
}
