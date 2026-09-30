import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  className?: string;
  children: ReactNode;
}

/** Joins truthy class fragments without pulling in an extra dependency. */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Maps the `padding` prop to the surface inner padding used by header/body/footer. */
const PADDING: Record<NonNullable<CardProps['padding']>, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-7',
};

/**
 * Rounded surface with a soft shadow, optional header (title/description) and footer.
 * Server-safe presentational component — no hooks, no state.
 */
export function Card({ title, description, footer, padding = 'md', className, children }: CardProps) {
  const pad = PADDING[padding];
  const hasTitle = title !== undefined;
  const hasDescription = description !== undefined;
  const hasHeader = hasTitle || hasDescription;

  return (
    <div
      className={cn(
        'rounded-2xl bg-white shadow-sm ring-1 ring-black/5 overflow-hidden',
        className,
      )}
    >
      {hasHeader ? (
        <div className={cn('border-b border-banking-light', pad)}>
          {hasTitle ? <div className="text-banking-navy font-semibold">{title}</div> : null}
          {hasDescription ? (
            <div className={cn('text-sm text-gray-500', hasTitle && 'mt-1')}>{description}</div>
          ) : null}
        </div>
      ) : null}

      <div className={pad}>{children}</div>

      {footer !== undefined ? (
        <div className={cn('border-t border-banking-light bg-banking-light/40 text-sm text-gray-600', pad)}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
