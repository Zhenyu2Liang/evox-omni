import type { ConsumeCardResult } from '@/banking-sdk/types';
import type { PendingActionStatus } from './security';

export interface CardConsumptionResponse {
  actionId: string;
  status: PendingActionStatus;
  ok: boolean;
  result?: ConsumeCardResult;
  attemptsLeft?: number;
  message?: string;
}
