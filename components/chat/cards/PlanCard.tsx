'use client';

import type { TaskNodeSpec, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import Link from 'next/link';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { AgentTaskTimeline } from '../../banking';
import type { TaskControlAction } from './types';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { Translator } from '@/lib/i18n/shared';
import { localizeToolLabel } from '@/lib/i18n/display';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';

export interface PlanCardProps {
  plan: TaskPlan;
  onControl?: (action: TaskControlAction) => void;
  busy?: boolean;
  className?: string;
}

const PLAN_STATUS_TONE: Record<TaskPlanStatus, 'neutral' | 'info' | 'success' | 'warn' | 'danger'> = {
  pending: 'neutral',
  running: 'info',
  paused: 'warn',
  waiting_confirmation: 'warn',
  success: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const CONTROL_VARIANT: Record<TaskControlAction, 'secondary' | 'danger'> = {
  pause: 'secondary',
  resume: 'secondary',
  cancel: 'danger',
  retry: 'secondary',
  rollback: 'secondary',
};

/**
 * The task-control actions offered for a plan status. Terminal plans (success/cancelled) offer
 * none; a running/queued plan can be paused or cancelled; a paused plan resumed or cancelled;
 * a failed plan retried.
 */
function controlActionsFor(status: TaskPlanStatus): TaskControlAction[] {
  switch (status) {
    case 'running':
    case 'pending':
    case 'waiting_confirmation':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'failed':
      return ['retry', 'cancel'];
    case 'success':
    case 'cancelled':
      return [];
  }
}

/**
 * Human-readable dependency line for a node: its direct dependencies resolved to node NAMES
 * (falling back to the raw id when a dependency is not part of this plan), or an explicit
 * start-of-graph label when it has none. Relationship text only — no status glyphs here.
 */
function dependencyLabel(node: TaskNodeSpec, nameById: Map<string, string>, t: Translator): string {
  const ordered = (node.after ?? []).map(id => localizeToolLabel(nameById.get(id) ?? id, t));
  if (node.dependencies.length === 0) {
    return ordered.length ? t('cards.plan.dependency.after', { names: ordered.join(', ') }) : t('cards.plan.dependency.none');
  }
  const names = node.dependencies.map((id) => localizeToolLabel(nameById.get(id) ?? id, t));
  return ordered.length
    ? t('cards.plan.dependency.combined', { dependencies: names.join(', '), ordered: ordered.join(', ') })
    : t('cards.plan.dependency.required', { names: names.join(', ') });
}

/**
 * Plan card: the plan goal + status badge, the per-node status timeline (composed
 * `AgentTaskTimeline`, the single status→meta source) and a dependency section that lists each
 * node's upstream node NAMES. A footer exposes the task-control actions for the current plan
 * status (pause/resume/cancel/retry) — these only call the injected `onControl` handler; the
 * browser never mutates the task itself. No chain-of-thought is rendered — only step names, tools,
 * the DAG relationships and the factual results (a failed node's `result.error` shows inline in
 * the timeline).
 */
export function PlanCard({ plan, onControl, busy, className }: PlanCardProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const nameById = new Map<string, string>(plan.nodes.map((node) => [node.id, node.name]));
  const controls = controlActionsFor(plan.status);
  // Completed record-creation plans may also be cancelled before explicit compensation.
  if (plan.status === 'success' && plan.results.some(result => result.status === 'success' && !result.compensation &&
      ['reserve_budget', 'create_scheduled_task'].includes(result.tool ?? ''))) controls.push('cancel');
  if (plan.status === 'cancelled' && plan.results.some(result => result.status === 'success' && !result.compensation &&
      ['reserve_budget', 'create_scheduled_task'].includes(result.tool ?? ''))) controls.push('rollback');

  const footer =
    controls.length > 0 ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {developerMode && plan.status === 'failed' && <Link href="/manual" className="text-sm text-banking-accent underline">{t('cards.manualReview')}</Link>}
        {controls.map((action) => (
          <Button
            key={action}
            variant={CONTROL_VARIANT[action]}
            size="md"
            disabled={busy || !onControl}
            onClick={() => onControl?.(action)}
          >
            {t(`cards.plan.control.${action}`)}
          </Button>
        ))}
      </div>
    ) : undefined;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          {t('cards.plan.title')}
          <Badge tone={PLAN_STATUS_TONE[plan.status]}>{t(`cards.plan.status.${plan.status}`)}</Badge>
        </span>
      }
      description={plan.goal}
      footer={footer}
    >
      <div className="space-y-3">
        <AgentTaskTimeline plan={plan} results={plan.results} />
        {plan.status === 'cancelled' && plan.results.some(result => result.status === 'success' &&
          ['reserve_budget', 'create_scheduled_task'].includes(result.tool ?? '')) &&
          <p className="text-sm text-gray-600">{t('cards.plan.rollbackBoundary')}</p>}
        {plan.results.some(result => result.compensation) && <section aria-label={t('cards.plan.rollbackLabel')} className="space-y-2">
          <h4 className="text-sm font-semibold">{t('cards.plan.rollbackTitle')}</h4>
          {plan.results.filter(result => result.compensation).map(result => <p key={result.id} className="text-sm">
            {result.name}：{result.compensation!.message}
          </p>)}
        </section>}

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t('cards.plan.dependencies')}</h4>
          <ul className="space-y-1.5">
            {plan.nodes.map((node) => (
              <li key={node.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-banking-deep">{localizeToolLabel(node.name, t)}</span>
                <span className="text-xs text-gray-500">{dependencyLabel(node, nameById, t)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Card>
  );
}
