import type { ReactNode } from 'react';

export interface BadgeProps {
  tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger';
  className?: string;
  children: ReactNode;
}

export function Badge(p: BadgeProps) {
  return null;
}
