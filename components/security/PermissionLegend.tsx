import type { RiskLevel } from '@/lib/contracts/risk';
import { RISK_LABEL } from '@/lib/constants';
import { StatusBadge } from '../ui/StatusBadge';

export interface PermissionLegendProps {
  className?: string;
}

/** The three permission tiers, in ascending risk order. */
const TIERS: readonly RiskLevel[] = ['GREEN', 'YELLOW', 'RED'];

/** Short human description of what each tier means for the user. */
const TIER_DESCRIPTION: Record<RiskLevel, string> = {
  GREEN: '自动执行 — 低风险查询无需确认，立即返回结果。',
  YELLOW: '需要用户确认 — 中风险操作需你点击确认后才会执行。',
  RED: '需要 MFA 验证 — 高风险操作需输入验证码完成强验证。',
};

export function PermissionLegend({ className }: PermissionLegendProps) {
  return (
    <div
      className={['space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm', className]
        .filter(Boolean)
        .join(' ')}
    >
      {TIERS.map((tier) => (
        <div key={tier} className="flex items-start gap-3">
          <StatusBadge tier={tier} label={RISK_LABEL[tier]} />
          <p className="text-sm leading-5 text-slate-600">{TIER_DESCRIPTION[tier]}</p>
        </div>
      ))}
    </div>
  );
}
