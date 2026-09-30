'use client';

/**
 * `Composer.tsx` — textarea + send button; enter-to-send.
 *
 * A controlled `<textarea>` paired with a submit `Button`. Enter sends (trimmed, non-empty) and
 * clears the input; Shift+Enter inserts a newline. Disabled while `disabled || busy`.
 */
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../ui';

export interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  className?: string;
}

const DEFAULT_PLACEHOLDER = '描述你的需求，例如：帮我看下这个月的消费';

export function Composer({
  onSend,
  disabled = false,
  busy = false,
  placeholder = DEFAULT_PLACEHOLDER,
  className,
}: ComposerProps) {
  const [text, setText] = useState('');
  const locked = disabled || busy;

  function submit() {
    if (locked) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed);
    setText('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className={['flex items-end gap-2', className].filter(Boolean).join(' ')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={locked}
        placeholder={placeholder}
        rows={2}
        className="min-h-[2.75rem] flex-1 resize-none rounded-xl border border-banking-navy/15 bg-white px-3 py-2 text-sm text-banking-navy placeholder:text-banking-navy/40 focus:border-banking-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      <Button type="submit" loading={busy} disabled={locked}>
        发送
      </Button>
    </form>
  );
}
