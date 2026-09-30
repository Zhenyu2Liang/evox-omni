'use client';

import type { ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Dialog(p: DialogProps) {
  return null;
}
