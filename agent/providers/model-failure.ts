import type { AssistantMessage } from '@earendil-works/pi-ai';

export interface ModelFailure {
  kind: 'timeout' | 'cancelled' | 'http' | 'transport' | 'provider';
  retryable: boolean;
  status?: number;
}

export type AuditedAssistantMessage = AssistantMessage & { bankingFailure?: ModelFailure };

/** Failure policy uses transport evidence, never provider error wording. */
export function retryableModelFailure(message: AssistantMessage): boolean {
  return (message as AuditedAssistantMessage).bankingFailure?.retryable === true;
}

export function httpModelFailure(status: number): ModelFailure {
  return { kind: 'http', status, retryable: status === 408 || status === 429 || status >= 500 && status < 600 };
}
