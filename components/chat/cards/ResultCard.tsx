import type { ReactNode } from 'react';
import { Card } from '../../ui';

export interface ResultCardProps {
  title: string;
  children: ReactNode;
  className?: string;
  description?: string;
  marker?: ReactNode;
}

/** Compact result surface shared by the read-only chat cards. */
export function ResultCard({ title, children, className, description, marker }: ResultCardProps) {
  return (
    <Card
      padding="sm"
      className={className}
      title={(
        <div className="flex items-center gap-2.5">
          {marker ? <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-banking-light text-banking-accent">{marker}</span> : null}
          <span className="text-sm font-semibold">{title}</span>
        </div>
      )}
      description={description}
    >
      {children}
    </Card>
  );
}

export function ResultMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-banking-light/70 p-3">
      <dt className="text-xs text-banking-navy/60">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold tabular-nums text-banking-deep">{children}</dd>
    </div>
  );
}
