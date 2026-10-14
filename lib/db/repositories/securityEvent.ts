import { Prisma, type SecurityEvent } from '@/lib/db/prisma';
import { prisma, type DbClient } from '../client';
import { toJson, safeParse } from '../../json';
import type {
  SecurityEvent as SecurityEventEntry,
  SecurityEventKind,
} from '../../contracts/audit';

export interface SecurityEventInput {
  sessionId: string;
  userId?: string | null;
  kind: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  detail?: string | null;
  timestamp?: Date;
}

export interface SecurityEventQuery {
  userId?: string;
  sessionId?: string;
  kind?: string;
  limit?: number;
}

/** Filter for {@link findSecurityEvents} — mirrors the audit node's `SecurityEventFilter`. */
export interface SecurityEventFindFilter {
  sessionId?: string;
  kind?: SecurityEventKind | string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

export function createSecurityEvent(
  input: SecurityEventInput,
): Promise<SecurityEvent> {
  return prisma.securityEvent.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      kind: input.kind,
      severity: input.severity,
      message: input.message,
      detail: input.detail ?? null,
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    },
  });
}

export function listSecurityEvents(
  query?: SecurityEventQuery,
): Promise<SecurityEvent[]> {
  return prisma.securityEvent.findMany({
    where: securityEventWhere(query),
    orderBy: { timestamp: 'desc' },
    take: query?.limit ?? DEFAULT_LIMIT,
  });
}

export function countSecurityEvents(
  query?: Omit<SecurityEventQuery, 'limit'>,
): Promise<number> {
  return prisma.securityEvent.count({ where: securityEventWhere(query) });
}

/**
 * Append one security event (the shape the audit node's `recordSecurityEvent` delegates to).
 * `detail` is stored as JSON text; `timestamp` (ms epoch) maps to a `DateTime`.
 *
 * `opts.client` optionally routes the write through an OPEN interactive transaction's client, so a
 * caller can commit a security event in the SAME `prisma.$transaction` as the state change it
 * records (e.g. an unlock + its `SECURITY_RESET` audit atomically together). Omitted (or `client`
 * undefined) → the global `prisma` singleton, i.e. the previous behavior, unchanged.
 */
export async function insertSecurityEvent(
  event: SecurityEventEntry,
  opts?: { client?: DbClient },
): Promise<SecurityEventEntry> {
  const row = await (opts?.client ?? prisma).securityEvent.create({
    data: {
      timestamp: new Date(event.timestamp),
      sessionId: event.sessionId,
      kind: event.kind,
      severity: event.severity,
      message: event.message,
      userId: event.userId ?? null,
      detail: event.detail == null ? null : toJson(event.detail),
    },
  });
  return toSecurityEventEntry(row);
}

/** Query security events, newest-first, by optional filter (the audit node's `listSecurityEvents`). */
export async function findSecurityEvents(
  filter: SecurityEventFindFilter = {},
): Promise<SecurityEventEntry[]> {
  const rows = await prisma.securityEvent.findMany({
    where: {
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: filter.limit ?? DEFAULT_LIMIT,
  });
  return rows.map(toSecurityEventEntry);
}

function securityEventWhere(
  query?: Omit<SecurityEventQuery, 'limit'>,
): Prisma.SecurityEventWhereInput {
  const where: Prisma.SecurityEventWhereInput = {};
  if (query?.userId) where.userId = query.userId;
  if (query?.sessionId) where.sessionId = query.sessionId;
  if (query?.kind) where.kind = query.kind;
  return where;
}

/** Maps a Prisma `SecurityEvent` row to the frozen contract shape (JSON text → value). */
function toSecurityEventEntry(row: SecurityEvent): SecurityEventEntry {
  return {
    id: row.id,
    timestamp: row.timestamp.getTime(),
    sessionId: row.sessionId,
    userId: row.userId ?? undefined,
    kind: row.kind as SecurityEventKind,
    severity: row.severity as SecurityEventEntry['severity'],
    message: row.message,
    detail: row.detail == null ? undefined : safeParse<unknown>(row.detail, row.detail),
  };
}
