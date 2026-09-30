import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-banking-light bg-white p-8 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="text-3xl text-gray-400" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <div className="text-banking-navy font-semibold">{title}</div>
      {description ? <p className="text-sm text-gray-500">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
