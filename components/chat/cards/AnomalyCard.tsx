'use client';

import type { AnomalyReport } from '@/banking-sdk';

export interface AnomalyCardProps {
  data: AnomalyReport;
  onAcknowledge?: () => void;
  onViewDetail?: () => void;
  onFreeze?: () => void;
  className?: string;
}

export function AnomalyCard(_p: AnomalyCardProps) {
  return null;
}
