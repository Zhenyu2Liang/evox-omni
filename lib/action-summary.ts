import type { PendingActionSummary } from './contracts/security';
import type { RiskLevel } from './contracts/risk';
import { RISK_LABEL } from './constants';

/** Display metadata follows the current authorization, including legacy stored summaries. */
export function withActionPolicy(
  summary: PendingActionSummary,
  policy: { tier: RiskLevel; requiresMfa: boolean; actionId?: string },
): PendingActionSummary {
  const tier = policy.requiresMfa ? 'RED' : policy.tier;
  return {
    ...summary, ...policy, tier,
    fields: (summary.fields ?? []).map(field => field.label === '风险等级'
      ? { ...field, value: RISK_LABEL[tier] } : field),
  };
}
