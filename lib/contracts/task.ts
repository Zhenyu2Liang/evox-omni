export type TaskNodeStatus = 'pending' | 'running' | 'waiting_confirmation' | 'waiting_verification' | 'success' | 'failed' | 'cancelled' | 'skipped';
export type TaskNodeKind = 'tool' | 'condition' | 'note';

export interface TaskCondition { path: string; op: '>' | '>=' | '<' | '<=' | '==' | '!='; value: number | string | boolean; }

export interface TaskNodeSpec {
  id: string;
  name: string;
  dependencies: string[];
  kind: TaskNodeKind;
  tool?: string;
  args?: Record<string, unknown>;
  condition?: TaskCondition;
}

export interface TaskNodeResult {
  id: string;
  name: string;
  status: TaskNodeStatus;
  tool?: string;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export type TaskPlanStatus = 'pending' | 'running' | 'paused' | 'waiting_confirmation' | 'success' | 'failed' | 'cancelled';

export interface TaskPlan {
  id: string;
  sessionId: string;
  goal: string;
  status: TaskPlanStatus;
  nodes: TaskNodeSpec[];
  results: TaskNodeResult[];
  createdAt: number;
  updatedAt: number;
  /**
   * Monotonic execution generation. Bumped whenever the plan's `executionToken`
   * is (re)claimed (initial claim or a stale-owner takeover). Consumers can reject
   * a stale (lower-generation) plan update event.
   */
  generation?: number;
}
