import { formatCNY, moneyToCents, type MoneyInput } from '@/lib/money';

export interface MoneyProps {
  amount: MoneyInput | bigint;
  signed?: boolean;
  className?: string;
}

/**
 * Renders a money amount via `lib/money.formatCNY` (never hand-formatted). `formatCNY`
 * already prefixes negatives with `-`; when `signed` is set, an explicit `+` is shown for
 * positive amounts. Server-safe presentational component — no hooks, no state.
 */
export function Money({ amount, signed = false, className }: MoneyProps) {
  const text = formatCNY(amount);
  const showPlus = signed === true && (typeof amount === 'bigint' ? amount : moneyToCents(amount)) > 0n;
  return (
    <span className={['tabular-nums', className].filter(Boolean).join(' ')}>
      {showPlus ? `+${text}` : text}
    </span>
  );
}
