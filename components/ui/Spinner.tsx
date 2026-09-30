export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-9 w-9',
};

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={cn(
        'inline-block animate-spin rounded-full border-2 border-banking-accent border-t-transparent',
        SIZE_CLASS[size],
        className,
      )}
    />
  );
}
