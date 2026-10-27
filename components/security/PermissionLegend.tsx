'use client';

import type { RiskLevel } from '@/lib/contracts/risk';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import { StatusBadge } from '../ui/StatusBadge';

export interface PermissionLegendProps {
  className?: string;
}

/** The three permission tiers, in ascending risk order. */
const TIERS: readonly RiskLevel[] = ['GREEN', 'YELLOW', 'RED'];

/** Short human description of what each tier means for the user. */
const TIER_DESCRIPTION: Record<RiskLevel, MessageKey> = {
  GREEN: 'security.permissions.greenDescription',
  YELLOW: 'security.permissions.yellowDescription',
  RED: 'security.permissions.redDescription',
};

export function PermissionLegend({ className }: PermissionLegendProps) {
  const { t } = useI18n();
  return (
    <div
      className={['space-y-3 rounded-2xl border border-banking-border bg-banking-surface p-5 shadow-xs', className]
        .filter(Boolean)
        .join(' ')}
    >
      {TIERS.map((tier) => (
        <div key={tier} className="flex items-start gap-3">
          <StatusBadge tier={tier} />
          <p className="text-sm leading-5 text-banking-navy">{t(TIER_DESCRIPTION[tier])}</p>
        </div>
      ))}
    </div>
  );
}
