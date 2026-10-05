import { beforeEach, afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, confirmAction, executeGatedTool } from '@/agent';
import { security } from '@/security';
import { runSubmitPlan } from '@/agent/tools/planning';
import { pauseTask, resumeTask } from '@/agent/task-control';
import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';
const userId = 'user_liming';
const gateway = security.gateway.securityGateway;
beforeEach(() => resetDatabase());
afterAll(() => disconnectTestPrisma());
async function session() { return (await getOrCreateSession(userId)).sessionId; }
async function post(handler: any, path: string, id: string, body: unknown = {}, cookie?: string) {
  const req = new NextRequest('http://localhost' + path, {method:'POST', headers:{'Content-Type':'application/json', ...(cookie ? {cookie} : {})}, body:JSON.stringify(body)});
  const res = await handler(req, {params: Promise.resolve({id})});
  return { status:res.status, cookie:res.headers.get('set-cookie'), ...(await res.json()) };
}
const transferNode = {id:'t', name:'转200',kind:'tool' as const, tool:'transfer_money',args:{name:'张伟',amount:200},dependencies:[]};
const budgetNode = {id:'b',name:'预算',kind:'tool' as const,tool:'reserve_budget',args:{name:'审查预算',amount:10},dependencies:['t']};
const depsFor = (s:string) => ({sessionId:s,runTool:(toolName:string,args:Record<string,unknown>)=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查'})});
it('chat cannot exchange a foreign body sessionId for its authorization cookie', async () => {
  const victim = await session(); const attacker = await session();
  const id=(await gateway.handleToolCall({sessionId:victim,userId,toolName:'transfer_money',args:{name:'张伟',amount:100},userRequest:'转100'})).action!.id;
  const turn=await post(chatPost,'/api/chat?stream=0','',{sessionId:victim,message:'查询余额'},`banking_session=${attacker}`);
  const result=await post(confirmPost,`/api/actions/${id}/confirm`,id,{},turn.cookie?.split(';')[0]);
  console.log('REVIEW takeover',JSON.stringify({turnStatus:turn.status,cookie:turn.cookie,confirmed:result.data?.ok,total:await security.risk.computeDailyTransferTotal(userId)}));
  expect(result.data?.ok).not.toBe(true);
});
it('resume preserves cancelled task status in durable storage',async()=>{
  const s=await session(); const created=await runSubmitPlan(userId,{goal:'转200',nodes:[transferNode]},depsFor(s));const plan:any=created.data;
  await post(taskPost,`/api/tasks/${plan.id}`,plan.id,{action:'cancel'},`banking_session=${s}`);
  const response=await post(taskPost,`/api/tasks/${plan.id}`,plan.id,{action:'resume'},`banking_session=${s}`);
  const stored=await getTestPrisma().agentTask.findUnique({where:{id:plan.id}});
  console.log('REVIEW cancelled_resume',JSON.stringify({responseStatus:response.status,responsePlan:response.data?.status,storedStatus:stored?.status}));
  expect(stored?.status).toBe('cancelled');
});
it('cancelling during tool authorization cannot create a fresh executable pending action',async()=>{
  const s=await session(); let cancelled:any;
  const created=await runSubmitPlan(userId,{goal:'转200',nodes:[transferNode]},{sessionId:s,runTool:async(tool,args)=>{
    const task=await getTestPrisma().agentTask.findFirst({where:{sessionId:s}});
    cancelled=await post(taskPost,`/api/tasks/${task!.id}`,task!.id,{action:'cancel'},`banking_session=${s}`);
    return depsFor(s).runTool(tool,args);
  }});
  const pending=await getTestPrisma().pendingAction.findFirst({where:{sessionId:s,status:'pending'}});
  let confirmed:any;
  if(pending) confirmed=await post(confirmPost,`/api/actions/${pending.id}/confirm`,pending.id,{},`banking_session=${s}`);
  const total=await security.risk.computeDailyTransferTotal(userId);
  console.log('REVIEW cancel_during_gate',JSON.stringify({cancelled:cancelled.data?.status,returnedPlan:(created.data as any)?.status,pending:!!pending,confirmed:confirmed?.data?.ok,total}));
  expect(total).toBe(0);
});
it('confirming a parked node respects an explicit plan pause',async()=>{
  const s=await session(); const created=await runSubmitPlan(userId,{goal:'转账再预算',nodes:[transferNode,budgetNode]},depsFor(s));const plan:any=created.data;
  await pauseTask(s,plan.id);
  await confirmAction(plan.results[0].output.pendingActionId,{sessionId:s,userId});
  const count=await getTestPrisma().budget.count({where:{name:'审查预算'}});
  const stored=await getTestPrisma().agentTask.findUnique({where:{id:plan.id}});
  console.log('REVIEW paused_confirmation',JSON.stringify({count,status:stored?.status}));
  expect(count).toBe(0);
});
it('two concurrent resumes execute each unfinished node only once',async()=>{
  const s=await session(); let taskId='';
  const created=await runSubmitPlan(userId,{goal:'暂停再预算',nodes:[{id:'t',name:'读',kind:'tool',tool:'get_balance',args:{},dependencies:[]},budgetNode]},{sessionId:s,runTool:async()=>{
    const task=await getTestPrisma().agentTask.findFirst({where:{sessionId:s}});taskId=task!.id;await pauseTask(s,taskId);return {ok:true,data:{balance:23580}};
  }});
  expect((created.data as any).status).toBe('paused');
  let calls=0;let reached!:()=>void;const atBoundary=new Promise<void>(r=>reached=r);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const deps={runTool:async(tool:string,args:Record<string,unknown>)=>{calls++;const outcome=await depsFor(s).runTool(tool,args);if(calls===1){reached();await gate;}return outcome;}};
  const first=resumeTask(s,taskId,deps);
  let second:any;
  try{await atBoundary;second=await resumeTask(s,taskId,deps);}finally{release();await first;}
  const count=await getTestPrisma().budget.count({where:{name:'审查预算'}});
  console.log('REVIEW double_resume',JSON.stringify({calls,secondOk:second?.ok,count}));
  expect(count).toBe(1);
});
it('concurrent HTTP resume requests do not duplicate budget side effects',async()=>{
  const s=await session(); let taskId='';
  await runSubmitPlan(userId,{goal:'暂停再预算',nodes:[{id:'t',name:'读',kind:'tool',tool:'get_balance',args:{},dependencies:[]},budgetNode]},{sessionId:s,runTool:async()=>{
    const task=await getTestPrisma().agentTask.findFirst({where:{sessionId:s}});taskId=task!.id;await pauseTask(s,taskId);return {ok:true,data:{balance:23580}};
  }});
  const replies=await Promise.all([post(taskPost,`/api/tasks/${taskId}`,taskId,{action:'resume'},`banking_session=${s}`),post(taskPost,`/api/tasks/${taskId}`,taskId,{action:'resume'},`banking_session=${s}`)]);
  const count=await getTestPrisma().budget.count({where:{name:'审查预算'}});
  console.log('REVIEW http_double_resume',JSON.stringify({statuses:replies.map(r=>r.status),count}));
  expect(count).toBe(1);
});
it('ledgered but not yet terminal actions are counted only once in cumulative risk',async()=>{
  const s=await session();
  const park=async(amount:number)=>(await gateway.handleToolCall({sessionId:s,userId,toolName:'transfer_money',args:{name:'张伟',amount},userRequest:`转${amount}`})).action!.id;
  const a=await park(600);const b=await park(100);
  const original=gateway.recordActionResult.bind(gateway);
  let reached!:()=>void;const atBoundary=new Promise<void>(r=>reached=r);
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const spy=vi.spyOn(gateway,'recordActionResult').mockImplementation(async(id,status)=>{
    if(id===a){reached();await gate;}await original(id,status);
  });
  const first=confirmAction(a,{sessionId:s,userId});
  let second:any;
  try {await atBoundary;second=await confirmAction(b,{sessionId:s,userId});}
  finally {release();await first;spy.mockRestore();}
  console.log('REVIEW double_count',JSON.stringify({secondOk:second.ok,secondTier:second.tier,secondStatus:second.status,actualTotal:await security.risk.computeDailyTransferTotal(userId)}));
  expect(second.ok).toBe(true);
  expect(second.requiresMfa).toBe(false);
});
