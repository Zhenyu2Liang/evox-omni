import type { ReactNode } from 'react';
import type { CardView } from '@/banking-sdk';

/** Shared, decorative card face. All card and account facts remain supplied by the caller. */
export function BankCardFace({ type, inactive, className, children }: {
  type: CardView['type']; inactive?: boolean; className?: string; children: ReactNode;
}) {
  return <div data-bank-card-face={type} data-card-inactive={inactive ? 'true' : undefined}
    className={`bank-card-face relative isolate overflow-hidden rounded-2xl p-4 text-banking-deep ${className ?? ''}`}>
    <span aria-hidden="true" className="pointer-events-none absolute -right-10 -top-14 -z-10 size-40 rounded-full border-[18px] border-white/35" />
    <span aria-hidden="true" className="pointer-events-none absolute -bottom-24 right-12 -z-10 size-40 rounded-full border border-white/55" />
    {children}
  </div>;
}
