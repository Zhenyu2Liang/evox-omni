'use client';

/**
 * `ToolEventList.tsx` — task/tool status timeline (NO chain-of-thought).
 *
 * Renders only task steps, tool status and factual results: a status glyph, the tool/label
 * name, the permission tier badge (when known) and the factual summary. Never model reasoning.
 */
import type { ToolEventView } from '@/lib/contracts/agent';
import { StatusBadge } from '../ui';

export interface ToolEventListProps {
  events: ToolEventView[];
  className?: string;
}

type ToolStatus = ToolEventView['status'];

interface StatusStyle {
  glyph: string;
  colour: string;
}

const STATUS_STYLE: Record<ToolStatus, StatusStyle> = {
  started: { glyph: '⏳', colour: 'text-banking-navy/60' },
  updated: { glyph: '…', colour: 'text-banking-navy/60' },
  success: { glyph: '✓', colour: 'text-banking-success' },
  error: { glyph: '✗', colour: 'text-banking-danger' },
  blocked: { glyph: '🔒', colour: 'text-banking-warn' },
};

export function ToolEventList({ events, className }: ToolEventListProps) {
  if (events.length === 0) {
    return null;
  }

  return (
    <ol
      className={['flex flex-col gap-1.5 rounded-xl bg-banking-light p-2.5', className]
        .filter(Boolean)
        .join(' ')}
    >
      {events.map((event) => {
        const style = STATUS_STYLE[event.status];
        return (
          <li key={event.toolCallId} className="flex items-start gap-2 text-xs">
            <span aria-hidden="true" className={['mt-px shrink-0', style.colour].join(' ')}>
              {style.glyph}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-banking-navy">
                  {event.label ?? event.toolName}
                </span>
                {event.tier ? <StatusBadge tier={event.tier} /> : null}
              </div>
              {event.summary ? (
                <span className="text-banking-navy/60">{event.summary}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
