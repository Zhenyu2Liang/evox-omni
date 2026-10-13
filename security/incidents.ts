import { prisma } from '@/lib/db/client';
import { realNow } from '@/lib/clock';
import { recordSecurityEvent } from '@/audit';
import { resolveBreakerOwner } from './circuit-breaker';
import type { SecurityEventKind } from '@/lib/contracts/audit';

export type RiskSignalKind = 'suspicious_instruction' | 'unauthorized_resource_access' | 'repeated_business_failure';
const SIGNAL_POLICY: Record<RiskSignalKind, { threshold: number; windowMs: number }> = {
  suspicious_instruction: { threshold: 3, windowMs: 10 * 60_000 },
  unauthorized_resource_access: { threshold: 3, windowMs: 10 * 60_000 },
  repeated_business_failure: { threshold: 5, windowMs: 5 * 60_000 },
};

/** Signal, incident event, and a resulting lock commit together. */
export async function recordRiskSignal(input: {
  sessionId: string; kind: RiskSignalKind; eventKind?: SecurityEventKind;
  message: string; detail?: unknown; dedupeKey?: string;
}): Promise<void> {
  const owner = await resolveBreakerOwner(input.sessionId);
  const now = new Date(realNow());
  const policy = SIGNAL_POLICY[input.kind];
  await prisma.$transaction(async client => {
    if (input.dedupeKey && await client.riskSignal.findUnique({ where: { dedupeKey: input.dedupeKey } })) return;
    await client.riskSignal.create({ data: { ownerKey: owner.key, sessionId: input.sessionId,
      kind: input.kind, dedupeKey: input.dedupeKey, createdAt: now } });
    await recordSecurityEvent({ sessionId: input.sessionId, userId: owner.userId,
      kind: input.eventKind ?? 'HIGH_RISK_BLOCKED', severity: 'medium', message: input.message,
      detail: { signal: input.kind, context: input.detail }, timestamp: now.getTime() }, { client, strict: true });
    const count = await client.riskSignal.count({ where: { ownerKey: owner.key, kind: input.kind,
      createdAt: { gte: new Date(now.getTime() - policy.windowMs) } } });
    const prior = await client.circuitBreakerState.findUnique({ where: { key: owner.key } });
    if (count < policy.threshold || prior?.locked) return;
    await client.circuitBreakerState.upsert({ where: { key: owner.key },
      create: { key: owner.key, userId: owner.userId, failures: count, locked: true, lockedAt: now },
      update: { failures: count, locked: true, lockedAt: now } });
    await recordSecurityEvent({ sessionId: input.sessionId, userId: owner.userId,
      kind: 'CIRCUIT_BREAKER_TRIPPED', severity: 'high', message: 'The account was locked after repeated risk signals.',
      timestamp: now.getTime(), detail: { signal: input.kind, count, threshold: policy.threshold, windowMs: policy.windowMs } },
    { client, strict: true });
  });
}
