import type { ReactNode } from 'react';
import type { SecurityEvent } from '@/lib/contracts/audit';

export interface SecurityEventListProps {
  events: SecurityEvent[];
  emptyText?: ReactNode;
  className?: string;
}

export function SecurityEventList(_props: SecurityEventListProps) {
  return null;
}
