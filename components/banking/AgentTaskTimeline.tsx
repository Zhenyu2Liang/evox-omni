'use client';

/**
 * AgentTaskTimeline — read-model tile: DAG step timeline (✓/○ per node) from a TaskPlan / its results.
 *
 * Localized display of the plan's node statuses.
 */
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { localizeToolLabel } from '@/lib/i18n/display';
import type { MessageKey } from '@/lib/i18n/shared';
import { publicToolError } from '@/lib/tool-feedback';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';

export interface AgentTaskTimelineProps {
  plan?: TaskPlan;
  results?: TaskNodeResult[];
  className?: string;
}

interface StatusMeta {
  icon: string;
  label: MessageKey;
  tone: BadgeProps['tone'];
  /** Tailwind text colour for the status marker. */
  text: string;
}

/**
 * Status → marker/label/tone. This is the single behavioural mapping of the timeline; every
 * `TaskNodeStatus` is covered so an unknown status can never fall through unrendered.
 */
const STATUS_META: Record<TaskNodeStatus, StatusMeta> = {
  pending: { icon: '○', label: 'tasks.timeline.pending', tone: 'neutral', text: 'text-gray-400' },
  running: { icon: '●', label: 'tasks.timeline.running', tone: 'info', text: 'text-banking-accent' },
  waiting_confirmation: { icon: '⏳', label: 'tasks.timeline.waitingConfirmation', tone: 'warn', text: 'text-banking-warn' },
  waiting_verification: { icon: '⏳', label: 'tasks.timeline.waitingVerification', tone: 'warn', text: 'text-banking-warn' },
  success: { icon: '✓', label: 'tasks.timeline.success', tone: 'success', text: 'text-banking-success' },
  failed: { icon: '✗', label: 'tasks.timeline.failed', tone: 'danger', text: 'text-banking-danger' },
  cancelled: { icon: '×', label: 'tasks.timeline.cancelled', tone: 'neutral', text: 'text-gray-400' },
  skipped: { icon: '–', label: 'tasks.timeline.skipped', tone: 'neutral', text: 'text-gray-400' },
};

/** Minimal row shape the timeline renders (spec `name`/`tool` enriched from the result). */
interface TimelineRow {
  id: string;
  name: string;
  tool?: string;
}

export function AgentTaskTimeline(props: AgentTaskTimelineProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const { plan, results, className } = props;

  const rootCls = ['shadow-xs', className].filter(Boolean).join(' ');

  // Order: prefer the planner's topological `plan.nodes`; otherwise fall back to the results.
  const specNodes = plan?.nodes ?? [];
  const ordered: TimelineRow[] =
    specNodes.length > 0
      ? specNodes.map((node) => ({
          id: node.id,
          name: node.name,
          ...(node.tool !== undefined ? { tool: node.tool } : {}),
        }))
      : (results ?? plan?.results ?? []).map((result) => ({
          id: result.id,
          name: result.name,
          ...(result.tool !== undefined ? { tool: result.tool } : {}),
        }));

  // Status source: prefer the live `results` prop, else the plan's own results.
  const resultSource = results ?? plan?.results ?? [];
  const resultById = new Map(resultSource.map((result) => [result.id, result]));

  if (ordered.length === 0) {
    return (
      <Card className={rootCls}>
        <EmptyState title={t('tasks.timeline.empty')} description={t('tasks.timeline.emptyDescription')} />
      </Card>
    );
  }

  return (
    <Card className={rootCls} title={plan?.goal ?? t('tasks.timeline.title')}>
      <ol className="space-y-3">
        {ordered.map((node) => {
          const result = resultById.get(node.id);
          const status: TaskNodeStatus = result?.status ?? 'pending';
          const meta = STATUS_META[status];
          const tool = node.tool ?? result?.tool;

          return (
            <li key={node.id} className="flex items-start gap-3">
              <span aria-hidden="true" className={`mt-0.5 w-4 text-center text-base font-semibold ${meta.text}`}>
                {meta.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-banking-deep">{localizeToolLabel(node.name, t)}</span>
                  <Badge tone={meta.tone}>{t(meta.label)}</Badge>
                </div>
                {developerMode && tool !== undefined && (
                  <div className="mt-0.5 text-xs text-gray-500">
                    {t('tasks.timeline.tool')}<code className="rounded-sm bg-banking-light px-1 py-0.5">{tool}</code>
                  </div>
                )}
                {status === 'failed' && result?.error !== undefined && (
                  <p className="mt-0.5 text-xs text-banking-danger">{publicToolError(result.error, t)}</p>
                )}
                {developerMode && status === 'failed' && result?.error !== undefined && <details className="mt-2 text-xs text-banking-navy">
                  <summary>{t('chat.diagnostics.detail')}</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words">{String(sanitizeToolArguments(result.error))}</pre>
                </details>}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
