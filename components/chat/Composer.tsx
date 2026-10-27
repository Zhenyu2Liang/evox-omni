'use client';

/**
 * `Composer.tsx` — textarea + send button; enter-to-send.
 *
 * A controlled `<textarea>` paired with a submit `Button`. Enter sends (trimmed, non-empty) and
 * clears the input; Shift+Enter inserts a newline. Disabled until hydrated and while disabled or busy.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { useAssistantHelp } from '@/components/help/AssistantHelp';

export interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  className?: string;
  draft?: { content: string };
  helpExamplesDisabled?: boolean;
}

function resizeInput(input: HTMLTextAreaElement | null) {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

const subscribeToReadiness = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function Composer({
  onSend,
  disabled = false,
  busy = false,
  placeholder,
  className,
  draft,
  helpExamplesDisabled = false,
}: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // An unhydrated native form must not navigate away before React attaches its submit handler.
  const ready = useSyncExternalStore(subscribeToReadiness, clientReady, serverReady);
  const locked = disabled || busy || !ready;
  const help = useAssistantHelp();
  const fillHelpExample = useCallback((content: string) => {
    setText(content);
    inputRef.current?.focus();
  }, []);
  const registerComposer = help?.registerComposer;
  const canUseHelpExample = !locked && !helpExamplesDisabled && text.length === 0;
  useEffect(() => registerComposer?.(canUseHelpExample ? fillHelpExample : undefined), [registerComposer, canUseHelpExample, fillHelpExample]);

  useEffect(() => {
    if (!draft) return;
    setText(draft.content);
    inputRef.current?.focus();
  }, [draft]);

  useEffect(() => {
    const input = inputRef.current;
    resizeInput(input);
  }, [text]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width !== previousWidth) {
        previousWidth = entry.contentRect.width;
        resizeInput(input);
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);

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
    // Enter commits an IME candidate before it can submit a message.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className={['flex items-end gap-3 rounded-2xl border border-banking-border bg-white p-3 shadow-[0_4px_24px_-12px_rgba(55,52,53,0.2)] transition focus-within:border-banking-accent focus-within:ring-2 focus-within:ring-banking-accent/10', className].filter(Boolean).join(' ')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={inputRef}
        aria-label={t('chat.composer.label')}
        data-chat-composer="true"
        data-chat-ready={ready ? 'true' : 'false'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={locked}
        placeholder={placeholder ?? t('chat.composer.placeholder')}
        rows={1}
        className="max-h-40 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-3 text-base leading-5 text-banking-deep placeholder:text-slate-400 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
      />
      <Button type="submit" loading={busy} disabled={locked || text.trim().length === 0} className="min-h-11 shrink-0 !rounded-xl !px-3 sm:!px-4">
        <span>{t('chat.composer.send')}</span>
        {!busy && <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="m5 12 7-7 7 7M12 5v14" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </Button>
    </form>
  );
}
