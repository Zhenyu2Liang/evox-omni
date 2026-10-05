'use client';

import type { TaskNodeSpec, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { AgentTaskTimeline } from '../../banking';

export interface PlanCardProps {
  plan: TaskPlan;
  className?: string;
}

const PLAN_STATUS_LABEL: Record<TaskPlanStatus, string> = {
  pending: '待执行',
  running: '执行中',
  waiting_confirmation: '等待确认',
  success: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

const PLAN_STATUS_TONE: Record<TaskPlanStatus, 'neutral' | 'info' | 'success' | 'warn' | 'danger'> = {
  pending: 'neutral',
  running: 'info',
  waiting_confirmation: 'warn',
  success: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

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
 * node's upstream node NAMES. No chain-of-thought is rendered — only step names, tools, the DAG
 * relationships and the factual results (a failed node's `result.error` shows inline in the timeline).
 */
export function PlanCard({ plan, className }: PlanCardProps) {
  const nameById = new Map<string, string>(plan.nodes.map((node) => [node.id, node.name]));

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
