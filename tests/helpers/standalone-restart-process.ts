import { getOrCreateSession } from '@/agent/session';
import { resumeTask } from '@/agent/task-control';
import { executeGatedTool } from '@/agent/confirmation/gated-execution';
import { tickAgentRecovery } from '@/agent/recovery-worker';
import { createTaskGraph } from '@/lib/db/repositories/task';
import { prisma } from '@/lib/db/client';
import type { ToolName } from '@/lib/contracts/tools';

const mode = process.argv[2];
const scenario = process.argv[3];
const userId = 'user_liming';
const host = mode === 'start' ? setInterval(() => undefined, 1000) : undefined;
function tell(value: unknown): void { process.send?.(value); }
function hold(): Promise<never> { return new Promise(() => undefined); }

async function main(): Promise<void> {
  if (mode !== 'start') {
    const result = await tickAgentRecovery();
    tell({ type: 'worker_finished', result });
    return;
  }
  const { sessionId } = await getOrCreateSession(userId);
  const task = await createTaskGraph({ sessionId, userId, goal: 'Resume the original standalone workflow' },
    scenario === 'authorization' ? [{
      nodeId: 'transfer', name: 'Transfer after human approval', kind: 'tool', tool: 'transfer_money',
      args: { contactId: 'contact_zhangwei', amount: '200.00' }, dependencies: [],
    }] : [
      { nodeId: 'budget', name: 'Reserve budget', kind: 'tool', tool: 'reserve_budget',
        args: { name: 'Standalone restart budget', amount: '10.00' }, dependencies: [] },
      { nodeId: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {}, dependencies: ['budget'] },
    ]);
  const barrier = () => tell({ type: 'barrier', runId: task.runId, sessionId, taskId: task.id });
  if (scenario === 'graph') { barrier(); await hold(); }
  await resumeTask(sessionId, task.id, { runTool: async (toolName, args, context) => {
    const result = await executeGatedTool({ ...context, sessionId, userId, toolName: toolName as ToolName,
      args, userRequest: task.goal });
    if (context.nodeId === 'budget' || result.requiresConfirmation) { barrier(); await hold(); }
    return result;
  } });
  throw new Error('The standalone workflow did not reach its requested crash barrier');
}

void main().catch(error => {
  tell({ type: 'fatal', message: error instanceof Error ? error.message : 'Standalone restart driver failed' });
  process.exitCode = 1;
}).finally(async () => {
  if (host) clearInterval(host);
  await prisma.$disconnect();
});
