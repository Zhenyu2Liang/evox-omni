'use client';

import type { ToolEventView } from '@/lib/contracts/agent';
import type { MessageKey } from '@/lib/i18n/shared';
import { StatusBadge } from '../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { ACTIVITY_CATEGORY_KEYS, groupToolActivity, type ToolActivityCategory } from './toolActivity';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { isMessageKey } from '@/lib/i18n/shared';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { publicToolSummary } from '@/lib/tool-feedback';

export interface ToolEventListProps {
  events: ToolEventView[];
  className?: string;
  compact?: boolean;
}

const STATUS_KEYS: Record<ToolEventView['status'], MessageKey> = {
  started: 'chat.activity.status.started', updated: 'chat.activity.status.updated',
  success: 'chat.activity.status.success', error: 'chat.activity.status.error',
  blocked: 'chat.activity.status.blocked',
  cancelled: 'chat.activity.status.cancelled', needs_reconciliation: 'chat.activity.status.needsReconciliation',
};

const STATUS_STYLE: Record<ToolEventView['status'], { glyph: string; colour: string }> = {
  started: { glyph: '…', colour: 'bg-banking-accent/10 text-banking-accent' },
  updated: { glyph: '…', colour: 'bg-banking-accent/10 text-banking-accent' },
  success: { glyph: '✓', colour: 'bg-emerald-50 text-banking-success' },
  error: { glyph: '×', colour: 'bg-red-50 text-banking-danger' },
  blocked: { glyph: '!', colour: 'bg-amber-50 text-banking-warn' },
  cancelled: { glyph: '×', colour: 'bg-slate-100 text-banking-navy' },
  needs_reconciliation: { glyph: '!', colour: 'bg-amber-50 text-banking-warn' },
};

const CATEGORY_PATH: Record<ToolActivityCategory, string> = {
  query: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  payment: 'M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4',
  card: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 5h18M7 15h4',
  investment: 'M3 20h18M6 16V9m6 7V5m6 11V2',
  workflow: 'M4 3h6v6H4V3Zm10 12h6v6h-6v-6ZM7 9v9h7M10 6h7v9',
};

/** Banking activity is derived exclusively from public call metadata and recorded summaries. */
export function ToolEventList({ events, className, compact = false }: ToolEventListProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const groups = groupToolActivity(events);
  if (groups.length === 0) return null;

  return (
    <div className={['space-y-2 text-xs', className].filter(Boolean).join(' ')}>
      {groups.map(group => (
        <section key={group.category} data-tool-category={group.category}
          aria-label={t(ACTIVITY_CATEGORY_KEYS[group.category])}
          className="overflow-hidden rounded-xl border border-slate-200/80 bg-banking-light/60">
          <div className="flex items-center gap-2 border-b border-slate-200/60 px-3 py-2 text-banking-navy">
            <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-banking-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d={CATEGORY_PATH[group.category]} />
            </svg>
            <h3 className="font-semibold">{t(ACTIVITY_CATEGORY_KEYS[group.category])}</h3>
          </div>
          <ol className="divide-y divide-slate-200/60">
            {group.events.map(event => {
              const style = STATUS_STYLE[event.status];
              const active = event.status === 'started' || event.status === 'updated';
              const key = `chat.tool.${event.toolName}`;
              const label = isMessageKey(key) ? t(key) : t('chat.activity.unknown');
              const showSummary = developerMode || !compact || ['error', 'blocked', 'needs_reconciliation'].includes(event.status);
              const summary = publicToolSummary(event, t);
              const diagnostic = developerMode ? sanitizeToolArguments(event.debugDetail ?? event.summary) : undefined;
              return (
                <li key={JSON.stringify([event.messageId, event.toolCallId])} data-tool-call-id={event.toolCallId} data-tool-status={event.status}
                  className="flex items-start gap-2.5 px-3 py-2.5">
                  <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-semibold ${style.colour} ${active ? 'animate-pulse' : ''}`}>
                    {style.glyph}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-banking-deep">{label}</span>
                      <span className={active ? 'text-banking-accent' : 'text-banking-navy'}>{t(event.status === 'blocked' && !event.actionId
                        ? 'chat.activity.status.notExecuted' : STATUS_KEYS[event.status])}</span>
                      {event.tier && (event.status === 'blocked' || developerMode) ? <StatusBadge tier={event.tier} /> : null}
                    </div>
                    {showSummary && summary ? <p className="whitespace-pre-wrap break-words leading-5 text-banking-navy">{summary}</p> : null}
                    {developerMode && <details data-tool-diagnostics="true" className="mt-2 rounded-lg border border-slate-200 bg-white p-2.5">
                      <summary className="cursor-pointer select-none font-medium text-banking-navy">{t('chat.diagnostics.title')}</summary>
                      <dl className="mt-3 space-y-2 text-[11px]">
                        <div className="flex flex-wrap justify-between gap-2"><dt>{t('chat.diagnostics.tool')}</dt><dd><code>{event.toolName}</code></dd></div>
                        <div className="flex flex-wrap justify-between gap-2"><dt>{t('chat.diagnostics.call')}</dt><dd className="break-all font-mono">{event.toolCallId}</dd></div>
                        {event.actionId ? <div className="flex flex-wrap justify-between gap-2"><dt>{t('chat.diagnostics.action')}</dt><dd className="break-all font-mono">{event.actionId}</dd></div> : null}
                        {event.debugDetail || event.summary ? <div><dt className="mb-1.5">{t('chat.diagnostics.detail')}</dt><dd><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-2 font-mono leading-5">{typeof diagnostic === 'string' ? diagnostic : JSON.stringify(diagnostic, null, 2)}</pre></dd></div> : null}
                        <div><dt className="mb-1.5">{t('chat.diagnostics.arguments')}</dt><dd>
                          {event.debugArguments === undefined ? <p>{t('chat.diagnostics.unavailable')}</p> :
                            <pre data-tool-arguments="true" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-2 font-mono leading-5">{JSON.stringify(sanitizeToolArguments(event.debugArguments), null, 2)}</pre>}
                        </dd></div>
                      </dl>
                    </details>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
