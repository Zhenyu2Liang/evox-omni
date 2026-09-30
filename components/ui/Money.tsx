import { formatCNY } from '@/lib/money';

export interface MoneyProps {
  amount: number;
  signed?: boolean;
  className?: string;
}

export function Money(p: MoneyProps) {
  // TODO(design-stub): render formatCNY(amount).
  void formatCNY;
  return null;
}
