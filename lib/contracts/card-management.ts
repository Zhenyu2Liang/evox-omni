import type { CardType, CardView } from '@/banking-sdk/types';
import type { MoneyAmount } from '@/lib/money';

export interface AddDemoCardRequest {
  requestId: string;
  type: CardType;
  creditLimit?: MoneyAmount;
  monthlyLimit?: MoneyAmount;
}

export interface CardChange {
  id: string;
  kind: 'add' | 'delete';
  status: 'pending' | 'executed' | 'cancelled' | 'locked';
  requiresMfa: true;
  type?: CardType;
  creditLimit?: MoneyAmount;
  monthlyLimit?: MoneyAmount;
  card?: CardView;
}

export interface CardChangeResponse {
  change: CardChange;
  ok?: boolean;
  attemptsLeft?: number;
  locked?: boolean;
}

export type ManualCardCommandName = 'manual_add_card' | 'manual_delete_card';
export const MANUAL_CARD_COMMAND_NAMES: ManualCardCommandName[] = ['manual_add_card', 'manual_delete_card'];
export function isManualCardCommand(name: string): name is ManualCardCommandName {
  return MANUAL_CARD_COMMAND_NAMES.includes(name as ManualCardCommandName);
}
