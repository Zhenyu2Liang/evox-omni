'use client';

import type { RiskLevel } from '@/lib/contracts/risk';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
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
 * Permission-tier pill. The visible label defaults to the current locale's permission text
 * and is overridden by an explicit `label` prop. Tier colours live here (and in `Badge`),
 * nowhere else. Explicit labels preserve the caller's domain-specific wording.
 */
export function StatusBadge({ tier, label, className }: StatusBadgeProps) {
  const { t } = useI18n();
  const keys: Record<RiskLevel, MessageKey> = { GREEN: 'ui.riskGreen', YELLOW: 'ui.riskYellow', RED: 'ui.riskRed' };
  return (
    <Badge tone={TIER_TONE[tier]} className={className}>
      {label ?? t(keys[tier])}
    </Badge>
  );
}
