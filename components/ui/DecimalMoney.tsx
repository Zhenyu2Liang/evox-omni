import { compareDecimal, formatDecimalCNY, type DecimalAmount } from '@/lib/decimal';

export interface DecimalMoneyProps {
  amount: DecimalAmount;
  signed?: boolean;
  className?: string;
}

/** Render an unrounded valuation without applying booked-money precision rules. */
export function DecimalMoney({ amount, signed = false, className }: DecimalMoneyProps) {
  const text = formatDecimalCNY(amount);
  const showPlus = signed && compareDecimal(amount, '0') > 0;
  return (
    <span className={['tabular-nums', className].filter(Boolean).join(' ')}>
      {showPlus ? `+${text}` : text}
    </span>
  );
}
