import type { ReactNode } from 'react';
import type { SecurityEvent } from '@/lib/contracts/audit';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';

export interface SecurityEventListProps {
  events: SecurityEvent[];
  emptyText?: ReactNode;
  className?: string;
}

const SEVERITY_TONE: Record<SecurityEvent['severity'], 'success' | 'warn' | 'danger'> = {
  high: 'danger',
  medium: 'warn',
  low: 'success',
};

const SEVERITY_LABEL: Record<SecurityEvent['severity'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

export function SecurityEventList({ events, emptyText, className }: SecurityEventListProps) {
  const rootClassName = ['space-y-3', className].filter(Boolean).join(' ');

  if (events.length === 0) {
    if (emptyText != null) {
      return <div className={rootClassName}>{emptyText}</div>;
    }
    return (
      <EmptyState
        className={rootClassName}
        title="暂无安全事件"
        description="系统尚未记录任何安全事件。"
      />
    );
  }

  return (
    <ul className={rootClassName}>
      {events.map((event, index) => (
        <li
          key={event.id ?? index}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge tone={SEVERITY_TONE[event.severity]}>{SEVERITY_LABEL[event.severity]}</Badge>
              <span className="text-sm font-medium text-banking-deep">{event.kind}</span>
            </div>
            <time className="text-xs text-slate-500">{formatTimestamp(event.timestamp)}</time>
          </div>
          <p className="mt-2 text-sm leading-5 text-slate-600">{event.message}</p>
        </li>
      ))}
    </ul>
  );
}
