'use client';

import type { TaskNodeSpec, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import Link from 'next/link';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { AgentTaskTimeline } from '../../banking';
import type { TaskControlAction } from './types';

export interface PlanCardProps {
  plan: TaskPlan;
  onControl?: (action: TaskControlAction) => void;
  busy?: boolean;
  className?: string;
}

const PLAN_STATUS_LABEL: Record<TaskPlanStatus, string> = {
  pending: '待执行',
  running: '执行中',
  paused: '已暂停',
  waiting_confirmation: '等待确认',
  success: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

const PLAN_STATUS_TONE: Record<TaskPlanStatus, 'neutral' | 'info' | 'success' | 'warn' | 'danger'> = {
  pending: 'neutral',
  running: 'info',
  paused: 'warn',
  waiting_confirmation: 'warn',
  success: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const CONTROL_LABEL: Record<TaskControlAction, string> = {
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  retry: '重试',
};

const CONTROL_VARIANT: Record<TaskControlAction, 'secondary' | 'danger'> = {
  pause: 'secondary',
  resume: 'secondary',
  cancel: 'danger',
  retry: 'secondary',
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
      return ['retry'];
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
function dependencyLabel(node: TaskNodeSpec, nameById: Map<string, string>): string {
  if (node.dependencies.length === 0) return '起始节点（无依赖）';
  const names = node.dependencies.map((id) => nameById.get(id) ?? id);
  return `依赖于: ${names.join('、')}`;
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
  const nameById = new Map<string, string>(plan.nodes.map((node) => [node.id, node.name]));
  const controls = controlActionsFor(plan.status);

  const footer =
    controls.length > 0 ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {plan.status === 'failed' && <Link href="/manual" className="text-sm text-banking-accent underline">转人工处理</Link>}
        {controls.map((action) => (
          <Button
            key={action}
            variant={CONTROL_VARIANT[action]}
            size="md"
            disabled={busy || !onControl}
            onClick={() => onControl?.(action)}
          >
            {CONTROL_LABEL[action]}
          </Button>
        ))}
      </div>
    ) : undefined;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          任务计划
          <Badge tone={PLAN_STATUS_TONE[plan.status]}>{PLAN_STATUS_LABEL[plan.status]}</Badge>
        </span>
      }
      description={plan.goal}
      footer={footer}
    >
      <div className="space-y-3">
        <AgentTaskTimeline plan={plan} results={plan.results} />

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">依赖关系</h4>
          <ul className="space-y-1.5">
            {plan.nodes.map((node) => (
              <li key={node.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-banking-deep">{node.name}</span>
                <span className="text-xs text-gray-500">{dependencyLabel(node, nameById)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Card>
  );
}
