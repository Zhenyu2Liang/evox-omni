'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Join truthy class names without pulling in an extra dependency. */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Dialog({ open, onClose, title, footer, className, children }: DialogProps) {
  // Close on Escape while the dialog is mounted and open. The listener only ever
  // attaches after mount, so no `document` access happens during SSR/render.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        className={cn('w-full max-w-lg rounded-2xl bg-white shadow-xl', className)}
      >
        {title ? (
          <div className="border-b border-banking-light px-5 py-4">
            <h2 className="text-banking-navy font-semibold">{title}</h2>
          </div>
        ) : null}

        <div className="px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex justify-end gap-2 border-t border-banking-light px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
