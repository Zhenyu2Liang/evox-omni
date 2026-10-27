import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Request surfaces keep header/footer visible while their details scroll. */
  layout?: 'default' | 'request';
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
export function Card({ title, description, footer, padding = 'md', layout = 'default', className, children }: CardProps) {
  const pad = PADDING[padding];
  const hasTitle = title !== undefined;
  const hasDescription = description !== undefined;
  const hasHeader = hasTitle || hasDescription;

  return (
    <div
      className={cn(
        'rounded-2xl bg-white shadow-[0_3px_16px_-10px_rgba(51,75,95,0.16)] ring-1 ring-banking-navy/10 overflow-hidden',
        layout === 'request' && 'flex min-h-0 flex-1 flex-col',
        className,
      )}
    >
      {hasHeader ? (
        <div className={cn('border-b border-banking-light', layout === 'request' && 'shrink-0', pad)}>
          {hasTitle ? <div className="text-banking-navy font-semibold">{title}</div> : null}
          {hasDescription ? (
            <div className={cn('text-sm text-gray-500', hasTitle && 'mt-1')}>{description}</div>
          ) : null}
        </div>
      ) : null}

      <div className={cn(pad, layout === 'request' && 'min-h-0 overflow-y-auto overscroll-contain')}>{children}</div>

      {footer !== undefined ? (
        <div className={cn('border-t border-banking-light bg-banking-light/40 text-sm text-gray-600', layout === 'request' && 'shrink-0', pad)}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
