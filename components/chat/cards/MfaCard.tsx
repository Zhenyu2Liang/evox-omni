'use client';

import { useState } from 'react';
import { Badge, Button, Card } from '../../ui';

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
 * typed by the user and verified server-side (this file deliberately imports nothing from
 * `@/lib/constants`, so the mock code can never leak into the UI).
 */
export function MfaCard(p: MfaCardProps) {
  const { actionId, hint, onSubmit, onCancel, busy, error, className } = p;
  const [code, setCode] = useState('');

  const trimmed = code.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit?.(trimmed);
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button variant="secondary" size="md" disabled={busy} onClick={() => onCancel?.(actionId)}>
        取消
      </Button>
      <Button variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={submit}>
        验证
      </Button>
    </div>
  );

  return (
    <Card className={className} title="身份验证" footer={footer}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-banking-navy/70">
          {hint ?? '该操作属于高风险操作，请输入短信验证码完成验证。'}
        </p>

        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="验证码"
          placeholder="请输入验证码"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full rounded-xl border border-banking-navy/20 bg-banking-light px-3 py-2 text-sm text-banking-navy outline-none transition focus:border-banking-accent disabled:opacity-60"
        />

        {error ? <Badge tone="danger">{error}</Badge> : null}
      </div>
    </Card>
  );
}
