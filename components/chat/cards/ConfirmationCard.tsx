'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';

export interface ConfirmationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onCancel?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  className?: string;
}

export function ConfirmationCard(_p: ConfirmationCardProps) {
  return null;
}
