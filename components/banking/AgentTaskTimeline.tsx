/**
 * AgentTaskTimeline — read-model tile: DAG step timeline (✓/○ per node) from a TaskPlan / its results.
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { TaskNodeResult, TaskPlan } from '@/lib/contracts/task';

export interface AgentTaskTimelineProps {
  plan?: TaskPlan;
  results?: TaskNodeResult[];
  className?: string;
}

export function AgentTaskTimeline(_props: AgentTaskTimelineProps) {
  return null;
}
