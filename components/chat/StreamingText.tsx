'use client';

/**
 * `StreamingText.tsx` — incremental assistant text with a caret while active.
 *
 * Renders only the assistant's factual text stream plus a blinking caret while a turn is
 * in flight. NEVER renders model reasoning / chain-of-thought.
 */
export interface StreamingTextProps {
  text: string;
  active?: boolean;
  className?: string;
}

export function StreamingText({ text, active = false, className }: StreamingTextProps) {
  const showHint = active && text.length === 0;

  return (
    <div
      className={['whitespace-pre-wrap break-words text-sm text-banking-navy', className]
        .filter(Boolean)
        .join(' ')}
    >
      {showHint ? (
        <span className="animate-pulse text-banking-navy/60">正在生成…</span>
      ) : (
        <span>{text}</span>
      )}
      {active && !showHint ? (
        <span aria-hidden="true" className="ml-0.5 animate-pulse text-banking-accent">
          ▍
        </span>
      ) : null}
    </div>
  );
}
