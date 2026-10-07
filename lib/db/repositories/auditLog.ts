import { Prisma } from '@prisma/client';
import type { AuditLog } from '@prisma/client';
import { prisma } from '../client';
import { toJson, safeParse } from '../../json';
import type { RiskLevel } from '../../contracts/risk';
import type { AuditEntry, AuditStatus } from '../../contracts/audit';

export interface AuditLogInput {
  sessionId: string;
  userId?: string | null;
  userRequest: string;
  intent?: string | null;
  toolName: string;
  riskLevel: RiskLevel | string;
  confirmationRequired?: boolean;
  confirmed?: boolean;
  mfaRequired?: boolean;
  mfaResult?: string | null;
  toolResult?: unknown;
  status: string;
  detail?: string | null;
  timestamp?: Date;
}

export interface AuditLogQuery {
  userId?: string;
  sessionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/** Filter for {@link findAuditLogs} — mirrors the audit node's `AuditFilter` (structural). */
export interface AuditLogFindFilter {
  sessionId?: string;
  toolName?: string;
  riskLevel?: RiskLevel | string;
  status?: AuditStatus | string;
  limit?: number;
}

/** Aggregate counts across the audit log (mirrors the audit node's `AuditSummary`). */
export interface AuditLogAggregate {
  total: number;
  byRisk: Record<string, number>;
  byStatus: Record<string, number>;
}

const DEFAULT_LIMIT = 100;

/** Optional composition + idempotency controls for {@link insertAuditLog}. */
export interface InsertAuditLogOptions {
  /** Transaction client to compose the insert into a caller's `prisma.$transaction`. */
  client?: Prisma.TransactionClient;
  /**
   * Idempotency key (maps to `AuditLog.dedupeKey`, unique). A repeat write for the SAME execution
   * identity is a duplicate (P2002); callers that must never throw absorb it (see `recordAudit`).
   */
  dedupeKey?: string;
}

export function createAuditLog(input: AuditLogInput): Promise<AuditLog> {
  return prisma.auditLog.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId ?? null,
      userRequest: input.userRequest,
      intent: input.intent ?? null,
      toolName: input.toolName,
      riskLevel: input.riskLevel,
      confirmationRequired: input.confirmationRequired ?? false,
      confirmed: input.confirmed ?? false,
      mfaRequired: input.mfaRequired ?? false,
      mfaResult: input.mfaResult ?? null,
      toolResult: input.toolResult === undefined ? null : toJson(input.toolResult),
      status: input.status,
      detail: input.detail ?? null,
      ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    },
  });
}

export function getAuditLog(id: string): Promise<AuditLog | null> {
  return prisma.auditLog.findUnique({ where: { id } });
}

export function listAuditLogs(query?: AuditLogQuery): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: auditWhere(query),
    orderBy: { timestamp: 'desc' },
    take: query?.limit ?? DEFAULT_LIMIT,
  });
}

export function countAuditLogs(
  query?: Omit<AuditLogQuery, 'limit'>,
): Promise<number> {
  return prisma.auditLog.count({ where: auditWhere(query) });
}

/**
 * Append one audit entry (the shape the audit node's `recordAudit` delegates to).
 * `toolResult` is stored as JSON text; `timestamp` (ms epoch) maps to a `DateTime`.
 */
export async function insertAuditLog(
  entry: AuditEntry,
  opts: InsertAuditLogOptions = {},
): Promise<AuditEntry> {
  const client = opts.client ?? prisma;
  const row = await client.auditLog.create({
    data: {
      timestamp: new Date(entry.timestamp),
      sessionId: entry.sessionId,
      userRequest: entry.userRequest,
      intent: entry.intent ?? null,
      toolName: entry.toolName,
      riskLevel: entry.riskLevel,
      confirmationRequired: entry.confirmationRequired,
      confirmed: entry.confirmed,
      mfaRequired: entry.mfaRequired,
      mfaResult: entry.mfaResult ?? null,
      toolResult: entry.toolResult === undefined ? null : toJson(entry.toolResult),
      status: entry.status,
      detail: entry.detail ?? null,
      dedupeKey: opts.dedupeKey ?? null,
    },
  });
  return toAuditEntry(row);
}

/** Query audit entries, newest-first, by optional filter (the audit node's `listAudit`). */
export async function findAuditLogs(filter: AuditLogFindFilter = {}): Promise<AuditEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(filter.toolName ? { toolName: filter.toolName } : {}),
      ...(filter.riskLevel ? { riskLevel: filter.riskLevel } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: filter.limit ?? DEFAULT_LIMIT,
  });
  return rows.map(toAuditEntry);
}

/** Aggregate counts (`total` / `byRisk` / `byStatus`) over the whole audit log. */
export async function aggregateAuditLogs(): Promise<AuditLogAggregate> {
  const rows = await prisma.auditLog.findMany({
    select: { riskLevel: true, status: true },
  });
  const byRisk: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    byRisk[row.riskLevel] = (byRisk[row.riskLevel] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  return { total: rows.length, byRisk, byStatus };
}

function auditWhere(
  query?: Omit<AuditLogQuery, 'limit'>,
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (query?.userId) where.userId = query.userId;
  if (query?.sessionId) where.sessionId = query.sessionId;
  if (query?.from || query?.to) {
    where.timestamp = {
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    };
  }
  return where;
}

/** Maps a Prisma `AuditLog` row to the frozen `AuditEntry` contract (JSON text → value). */
function toAuditEntry(row: AuditLog): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp.getTime(),
    sessionId: row.sessionId,
    userRequest: row.userRequest,
    intent: row.intent ?? undefined,
    toolName: row.toolName,
    riskLevel: row.riskLevel as RiskLevel,
    confirmationRequired: row.confirmationRequired,
    confirmed: row.confirmed,
    mfaRequired: row.mfaRequired,
    mfaResult: (row.mfaResult ?? undefined) as AuditEntry['mfaResult'],
    toolResult:
      row.toolResult == null ? undefined : safeParse<unknown>(row.toolResult, undefined),
    status: row.status as AuditStatus,
    detail: row.detail ?? undefined,
  };
}
