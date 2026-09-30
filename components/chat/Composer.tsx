'use client';

/**
 * `Composer.tsx` — textarea + send button; enter-to-send.
 *
 * DESIGN-STUB phase: renders nothing; the real input lands in the implementation phase.
 */
export interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  className?: string;
}

export function Composer(p: ComposerProps) {
  return null;
}
