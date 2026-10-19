import { compareDecimal, formatDecimalCNY, type DecimalAmount } from '@/lib/decimal';

export interface DecimalMoneyProps {
  amount: DecimalAmount;
  signed?: boolean;
  className?: string;
}

/**
 * Render the stored valuation as grouped CNY text for display only.
 * `formatDecimalCNY` rounds HALF_UP to exactly two fraction digits, keeping the sign and
 * thousands separators; the underlying valuation keeps its full precision.
 */
export function DecimalMoney({ amount, signed = false, className }: DecimalMoneyProps) {
  const text = formatDecimalCNY(amount);
  const showPlus = signed && compareDecimal(amount, '0') > 0;
  return (
    <span className={['tabular-nums', className].filter(Boolean).join(' ')}>
      {showPlus ? `+${text}` : text}
    </span>
  );
}
