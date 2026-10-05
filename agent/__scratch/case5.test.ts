import { beforeEach, afterAll, it } from 'vitest';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { pauseTask, resumeTask } from '@/agent/task-control';
import { NextRequest } from 'next/server';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterAll(() => disconnectTestPrisma());
async function session() { return (await getOrCreateSession(userId)).sessionId; }
async function post(handler: any, path: string, id: string, body: unknown = {}, cookie?: string) {
  const req = new NextRequest('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const res = await handler(req, { params: Promise.resolve({ id }) });
  return { status: res.status, cookie: res.headers.get('set-cookie'), ...(await res.json()) };
}
const budgetNode = { id: 'b', name: '预算', kind: 'tool' as const, tool: 'reserve_budget', args: { name: '审查预算', amount: 10 }, dependencies: ['t'] };
const depsFor = (s: string) => ({ sessionId: s, runTool: (toolName: string, args: Record<string, unknown>) => executeGatedTool({ sessionId: s, userId, toolName: toolName as any, args, userRequest: '审查' }) });

async function setup(s: string) {
  let taskId = '';
  const created = await runSubmitPlan(userId, { goal: '暂停再预算', nodes: [{ id: 't', name: '读', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] }, budgetNode] }, {
    sessionId: s,
    runTool: async () => {
      const task = await getTestPrisma().agentTask.findFirst({ where: { sessionId: s } });
      taskId = task!.id;
      await pauseTask(s, taskId);
      return { ok: true, data: { balance: 23580 } };
    },
  });
  console.log('DIAG case5-setup', JSON.stringify({ createdStatus: (created.data as any).status }));
  return taskId;
}

it('MIRROR case5 with barrier + diag', async () => {
  const s = await session();
  const taskId = await setup(s);
  let calls = 0, released = false;
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  setTimeout(() => { console.log('DIAG case5-after2s', JSON.stringify({ calls, released })); release(); }, 2000);
  const deps = { runTool: async (tool: string, args: Record<string, unknown>) => { calls++; if (calls === 2) { released = true; release(); } await gate; return depsFor(s).runTool(tool, args); } };
  await Promise.all([resumeTask(s, taskId, deps), resumeTask(s, taskId, deps)]);
  const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId }, include: { nodes: true } });
  console.log('DIAG case5-final', JSON.stringify({ calls, released, rowStatus: row!.status, nodes: row!.nodes.map((n) => ({ id: n.nodeId, status: n.status })), count: await getTestPrisma().budget.count({ where: { name: '审查预算' } }) }));
});

it('MIRROR case6 http no barrier', async () => {
  const s = await session();
  const taskId = await setup(s);
  const replies = await Promise.all([post(taskPost, `/api/tasks/${taskId}`, taskId, { action: 'resume' }, `banking_session=${s}`), post(taskPost, `/api/tasks/${taskId}`, taskId, { action: 'resume' }, `banking_session=${s}`)]);
  const count = await getTestPrisma().budget.count({ where: { name: '审查预算' } });
  console.log('DIAG case6', JSON.stringify({ statuses: replies.map((r) => r.status), count }));
});
