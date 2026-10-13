import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorkflowExecutionClaim {
  taskId: string;
  nodeId: string;
  planToken: string | undefined;
  nodeToken: string | undefined;
  explicitRetry?: boolean;
}

const claims = new AsyncLocalStorage<WorkflowExecutionClaim>();
export function currentWorkflowExecutionClaim(): WorkflowExecutionClaim | undefined { return claims.getStore(); }
export function withWorkflowExecutionClaim<T>(claim: WorkflowExecutionClaim, execute: () => Promise<T>): Promise<T> {
  return claims.run(claim, execute);
}
