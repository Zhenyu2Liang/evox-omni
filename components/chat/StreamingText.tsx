'use client';

import { useI18n } from '@/lib/i18n/LocaleProvider';
import { AssistantMarkdown } from './AssistantMarkdown';

/**
 * `StreamingText.tsx` — a validated reply and safe phase hint while a request is active.
 *
 * The server publishes whole validated replies. Progress hints never expose unpublished candidate
 * text, model reasoning or corrective instructions, and the component does not simulate typing.
 */
export interface StreamingTextProps {
  text: string;
  active?: boolean;
  phase?: 'generating' | 'checking' | 'repairing';
  className?: string;
}

export function StreamingText({ text, active = false, phase, className }: StreamingTextProps) {
  const { t } = useI18n();
  const showHint = active && text.length === 0;

  return (
    <div
      className={['break-words text-sm text-banking-navy', className]
        .filter(Boolean)
        .join(' ')}
    >
      {showHint ? (
        <span className="animate-pulse text-banking-navy/80">{t(phase ? `chat.replyProgress.${phase}` : 'chat.working')}</span>
      ) : (
        <AssistantMarkdown text={text} />
      )}
      {active && !showHint ? (
        <span aria-hidden="true" className="ml-0.5 animate-pulse text-banking-interactive">
          ▍
        </span>
      ) : null}
    </div>
  );
}
