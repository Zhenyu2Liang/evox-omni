import type { RiskLevel } from '@/lib/contracts/risk';
import { RISK_LABEL } from '@/lib/constants';

export interface StatusBadgeProps {
  tier: RiskLevel;
  label?: string;
  className?: string;
}

export function StatusBadge(p: StatusBadgeProps) {
  // TODO(design-stub): default visible label comes from RISK_LABEL[tier].
  void RISK_LABEL;
  return null;
}
