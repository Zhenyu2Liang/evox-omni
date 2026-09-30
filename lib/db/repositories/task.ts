import type { AgentTask, AgentTaskNode } from '@prisma/client';
import type { TaskCondition } from '../../contracts/task';

export type AgentTaskWithNodes = AgentTask & { nodes: AgentTaskNode[] };

export interface CreateTaskInput {
  sessionId: string;
  userId: string;
  goal: string;
  status?: string;
}

export interface CreateTaskNodeInput {
  taskId: string;
  nodeId: string;
  name: string;
  kind: string;
  order: number;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  condition?: TaskCondition | null;
  dependencies?: string[];
  status?: string;
}

export interface UpdateTaskNodeInput {
  status?: string;
  output?: unknown;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

export function createTask(input: CreateTaskInput): Promise<AgentTask> {
  throw new Error('not implemented');
}

export function getTask(id: string): Promise<AgentTaskWithNodes | null> {
  throw new Error('not implemented');
}

export function listTasksBySession(sessionId: string): Promise<AgentTask[]> {
  throw new Error('not implemented');
}

export function updateTaskStatus(id: string, status: string): Promise<AgentTask> {
  throw new Error('not implemented');
}

export function createTaskNode(input: CreateTaskNodeInput): Promise<AgentTaskNode> {
  throw new Error('not implemented');
}

export function getTaskNode(
  taskId: string,
  nodeId: string,
): Promise<AgentTaskNode | null> {
  throw new Error('not implemented');
}

export function updateTaskNode(
  taskId: string,
  nodeId: string,
  update: UpdateTaskNodeInput,
): Promise<AgentTaskNode> {
  throw new Error('not implemented');
}

export function updateTaskNodeStatus(
  taskId: string,
  nodeId: string,
  status: string,
): Promise<AgentTaskNode> {
  throw new Error('not implemented');
}

export function deleteTask(id: string): Promise<void> {
  throw new Error('not implemented');
}
