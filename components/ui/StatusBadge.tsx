import type { RiskLevel } from '@/lib/contracts/risk';
import { RISK_LABEL } from '@/lib/constants';
import { Badge } from './Badge';

export interface StatusBadgeProps {
  tier: RiskLevel;
  label?: string;
  className?: string;
}

/** Permission tier → badge tone (same colour families as `Badge`). */
const TIER_TONE: Record<RiskLevel, 'success' | 'warn' | 'danger'> = {
  GREEN: 'success',
  YELLOW: 'warn',
  RED: 'danger',
};

/**
 * Permission-tier pill (🟢/🟡/🔴). The visible label defaults to `RISK_LABEL[tier]`
 * and is overridden by an explicit `label` prop. Tier colours live here (and in `Badge`),
 * nowhere else. Server-safe presentational component — no hooks, no state.
 */
export function StatusBadge({ tier, label, className }: StatusBadgeProps) {
  return (
    <Badge tone={TIER_TONE[tier]} className={className}>
      {label ?? RISK_LABEL[tier]}
    </Badge>
  );
}
