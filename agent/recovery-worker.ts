import { AppError } from '@/lib/errors';
import { listRecoverableAgentRuns } from '@/lib/db/repositories/agentRun';
import { getOwnedRunSummary, recoverOwnedRun, type RunRecoveryResponse } from './durable/service';

export interface RecoveryCandidate {
  id: string;
  sessionId: string;
  userId: string;
}

export interface RecoveryWorkerPorts {
  discover(now: Date, limit: number): Promise<readonly RecoveryCandidate[]>;
  recover(run: RecoveryCandidate): Promise<RunRecoveryResponse>;
  inspect?(run: RecoveryCandidate): Promise<{ status: string; errorCode: string | null }>;
}

export interface RecoveryTickResult {
  discovered: number;
  outcomes: Array<{ runId: string; status: string; errorCode?: string }>;
}

export interface RecoveryWorkerOptions {
  limit?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  ports?: RecoveryWorkerPorts;
  onTick?: (result: RecoveryTickResult) => void | Promise<void>;
}

const DEFAULT_PORTS: RecoveryWorkerPorts = {
  discover: listRecoverableAgentRuns,
  recover: run => recoverOwnedRun(run.id, { sessionId: run.sessionId, userId: run.userId }),
  inspect: run => getOwnedRunSummary(run.id, run),
};

function batchLimit(value = 25): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new AppError('VALIDATION', 'Recovery batch limit must be an integer from 1 through 100.');
  }
  return value;
}

/** A batch discovers due work; each recovery still claims its own persisted execution lease. */
export async function tickAgentRecovery(options: RecoveryWorkerOptions = {}): Promise<RecoveryTickResult> {
  const limit = batchLimit(options.limit);
  const ports = options.ports ?? DEFAULT_PORTS;
  if (options.signal?.aborted) return { discovered: 0, outcomes: [] };
  const runs = await ports.discover(new Date(), limit);
  const outcomes: RecoveryTickResult['outcomes'] = [];
  // SQLite writes and per-session model execution are deliberately not parallelized here.
  for (const run of runs) {
    if (options.signal?.aborted) break;
    try {
      const result = await ports.recover(run);
      outcomes.push({ runId: run.id, status: result.run.status });
    } catch (error) {
      // Discovery is advisory. A concurrent worker or foreground turn may have won the lease.
      const failure = AppError.from(error);
      let status = failure.code === 'CONFLICT' ? 'busy' : 'failed';
      let errorCode: string = failure.code;
      try {
        const persisted = await ports.inspect?.(run);
        if (persisted) {
          status = persisted.status === 'running' ? 'busy' : persisted.status;
          errorCode = persisted.errorCode ?? failure.code;
        }
      } catch { /* Diagnostics cannot replace the original recovery failure. */ }
      outcomes.push({ runId: run.id, status, errorCode });
    }
  }
  return { discovered: runs.length, outcomes };
}

function waitForNextTick(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Graceful shutdown drains the current recovery and stops before admitting another run. */
export async function runAgentRecoveryWorker(options: RecoveryWorkerOptions = {}): Promise<void> {
  batchLimit(options.limit);
  const intervalMs = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) {
    throw new AppError('VALIDATION', 'Recovery interval must be an integer from 250 through 60000 milliseconds.');
  }
  while (!options.signal?.aborted) {
    const result = await tickAgentRecovery(options);
    await options.onTick?.(result);
    await waitForNextTick(intervalMs, options.signal);
  }
}
