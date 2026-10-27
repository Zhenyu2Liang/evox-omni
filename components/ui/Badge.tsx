import type { ReactNode } from 'react';

export interface BadgeProps {
  tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger';
  className?: string;
  children: ReactNode;
}

/** Joins truthy class fragments without pulling in an extra dependency. */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Semantic colour families for each badge tone (banking palette + neutral chrome). */
const TONE: Record<NonNullable<BadgeProps['tone']>, string> = {
  neutral: 'bg-gray-100 text-gray-700',
  info: 'bg-banking-neutral text-banking-interactive',
  success: 'bg-green-50 text-banking-success',
  warn: 'bg-amber-50 text-banking-warn',
  danger: 'bg-red-50 text-banking-danger',
};

/**
 * Small inline pill used for statuses, categories and tags.
 * Server-safe presentational component — no hooks, no state.
 */
export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
