/**
 * AgentTaskTimeline — read-model tile: DAG step timeline (✓/○ per node) from a TaskPlan / its results.
 *
 * Server-safe (no `'use client'`, no hooks): pure display of the plan's node statuses.
 */
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';

export interface AgentTaskTimelineProps {
  plan?: TaskPlan;
  results?: TaskNodeResult[];
  className?: string;
}

interface StatusMeta {
  icon: string;
  label: string;
  tone: BadgeProps['tone'];
  /** Tailwind text colour for the status marker. */
  text: string;
}

/**
 * Status → marker/label/tone. This is the single behavioural mapping of the timeline; every
 * `TaskNodeStatus` is covered so an unknown status can never fall through unrendered.
 */
const STATUS_META: Record<TaskNodeStatus, StatusMeta> = {
  pending: { icon: '○', label: '待执行', tone: 'neutral', text: 'text-gray-400' },
  running: { icon: '●', label: '执行中', tone: 'info', text: 'text-banking-accent' },
  waiting_confirmation: { icon: '⏳', label: '待确认', tone: 'warn', text: 'text-banking-warn' },
  waiting_verification: { icon: '⏳', label: '待验证', tone: 'warn', text: 'text-banking-warn' },
  success: { icon: '✓', label: '成功', tone: 'success', text: 'text-banking-success' },
  failed: { icon: '✗', label: '失败', tone: 'danger', text: 'text-banking-danger' },
  cancelled: { icon: '×', label: '已取消', tone: 'neutral', text: 'text-gray-400' },
  skipped: { icon: '–', label: '已跳过', tone: 'neutral', text: 'text-gray-400' },
};

/** Minimal row shape the timeline renders (spec `name`/`tool` enriched from the result). */
interface TimelineRow {
  id: string;
  name: string;
  tool?: string;
}

export function AgentTaskTimeline(props: AgentTaskTimelineProps) {
  const { plan, results, className } = props;

  const rootCls = ['shadow-sm', className].filter(Boolean).join(' ');

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
        <EmptyState title="暂无任务" description="尚未生成任务计划。" />
      </Card>
    );
  }

  return (
    <Card className={rootCls} title={plan?.goal ?? '任务执行'}>
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
                  <span className="text-sm font-medium text-banking-deep">{node.name}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </div>
                {tool !== undefined && (
                  <div className="mt-0.5 text-xs text-gray-500">
                    工具：<code className="rounded bg-banking-light px-1 py-0.5">{tool}</code>
                  </div>
                )}
                {status === 'failed' && result?.error !== undefined && (
                  <p className="mt-0.5 text-xs text-banking-danger">{result.error}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
