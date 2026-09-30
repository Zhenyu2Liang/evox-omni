import { MFA_MAX_ATTEMPTS } from '@/lib/constants';

export interface CircuitBreakerStatusProps {
  tripped: boolean;
  failureCount?: number;
  maxAttempts?: number;
  className?: string;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function CircuitBreakerStatus({
  tripped,
  failureCount = 0,
  maxAttempts = MFA_MAX_ATTEMPTS,
  className,
}: CircuitBreakerStatusProps) {
  const safeMaxAttempts = maxAttempts > 0 ? maxAttempts : 0;
  const ratio = safeMaxAttempts > 0 ? clampRatio(failureCount / safeMaxAttempts) : 0;

  const dotClass = tripped ? 'bg-banking-danger' : 'bg-banking-success';
  const labelClass = tripped ? 'text-banking-danger' : 'text-banking-success';
  const barClass = tripped
    ? 'bg-banking-danger'
    : failureCount > 0
      ? 'bg-banking-warn'
      : 'bg-banking-success';

  return (
    <div
      className={[
        'rounded-2xl border bg-white p-5 shadow-sm',
        tripped ? 'border-banking-danger/40' : 'border-slate-200',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`} aria-hidden />
          <span className={`text-sm font-semibold ${labelClass}`}>
            {tripped ? '已熔断' : '正常'}
          </span>
        </div>
        <span className="text-xs text-slate-500">高风险操作熔断状态</span>
      </div>

      <p className="mt-2 text-sm leading-5 text-slate-600">
        {tripped
          ? '连续验证失败次数已达上限，本会话内的高风险操作已被锁定。'
          : '高风险操作保护已启用，连续验证失败达到上限后会自动熔断。'}
      </p>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>连续失败次数</span>
          <span>
            失败 {failureCount} / {safeMaxAttempts} 次
          </span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-banking-light">
          <div
            className={`h-full rounded-full transition-all ${barClass}`}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
