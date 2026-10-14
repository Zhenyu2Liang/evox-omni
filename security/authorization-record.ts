import { prisma } from '@/lib/db/client';
import { canonicalCommandArgs } from '@/lib/contracts/command';
import { requestDigest } from '@/lib/ledger';
import { toJson } from '@/lib/json';
import { redactSecrets } from '@/lib/sensitive';
import type { SecurityDecision } from '@/lib/contracts/security';
import type { GatewayContext } from './security-gateway';

export const AUTHORIZATION_POLICY_VERSION = 'banking-policy-v3';

/** Persist decision facts, including denials, without recording hidden model reasoning. */
export async function recordAuthorizationDecision(context: GatewayContext, decision: SecurityDecision): Promise<string> {
  const command = canonicalCommandArgs(context.args);
  const row = await prisma.authorizationDecision.create({ data: {
    sessionId: context.sessionId, userId: context.userId, toolName: context.toolName,
    commandDigest: requestDigest({ userId: context.userId, toolName: context.toolName, args: command }),
    commandJson: toJson(redactSecrets(command)), policyVersion: AUTHORIZATION_POLICY_VERSION,
    decision: decision.kind, tier: decision.tier, reasonsJson: toJson(decision.evaluation.reasons),
    riskInputsJson: toJson({ amount: decision.evaluation.amount, dailyTotal: decision.evaluation.dailyTotal,
      blocked: decision.evaluation.blocked, blockReason: decision.evaluation.blockReason }),
    taskId: context.taskId, nodeId: context.nodeId,
  } });
  return row.id;
}
