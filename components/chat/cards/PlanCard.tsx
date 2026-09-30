'use client';

import type { TaskNodeResult, TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
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

/** A node is marked ✓ only once its result reports `success`, every other state renders ○. */
function stepMark(status: TaskNodeResult['status'] | undefined): string {
  return status === 'success' ? '✓' : '○';
}

/**
 * Plan card: the plan goal + status, the `AgentTaskTimeline` read-model, and an explicit DAG step
 * list (✓/○ per node, driven by the matching `TaskNodeResult.status`). No chain-of-thought is
 * rendered — only step names, their tool and their status.
 */
export function PlanCard({ plan, className }: PlanCardProps) {
  const resultsById = new Map<string, TaskNodeResult>(plan.results.map((r) => [r.id, r]));

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

        <ol className="space-y-2">
          {plan.nodes.map((node) => {
            const result = resultsById.get(node.id);
            const done = result?.status === 'success';
            return (
              <li key={node.id} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs ${
                    done ? 'bg-banking-success text-white' : 'bg-banking-light text-slate-500'
                  }`}
                >
                  {stepMark(result?.status)}
                </span>
                <div className="min-w-0">
                  <span className={`block text-sm ${done ? 'text-banking-deep' : 'text-slate-600'}`}>
                    {node.name}
                  </span>
                  {node.tool && <span className="block text-xs text-slate-400">{node.tool}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}
