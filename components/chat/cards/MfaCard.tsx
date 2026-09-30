'use client';

export interface MfaCardProps {
  actionId: string;
  hint?: string;
  onSubmit?: (code: string) => void;
  onCancel?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  className?: string;
}

/**
 * RED-tier verification surface. It renders the `hint` ONLY — never an MFA code; the code is
 * typed by the user and verified server-side.
 */
export function MfaCard(_p: MfaCardProps) {
  return null;
}
