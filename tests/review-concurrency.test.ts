import { beforeEach, afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { pauseTask, resumeTask } from '@/agent/task-control';
import { runSubmitPlan } from '@/agent/tools/planning';
import { security } from '@/security';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterAll(()=>disconnectTestPrisma());
async function session(){return (await getOrCreateSession(userId)).sessionId;}
async function post(handler:any,id:string,body:unknown,s:string,path?:string){const res=await handler(new NextRequest('http://localhost'+(path??`/api/tasks/${id}`),{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify(body)}),{params:Promise.resolve({id})});return {httpStatus:res.status,...await res.json()};}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>)=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查'});
const budget={id:'b',name:'预算',kind:'tool' as const,tool:'reserve_budget',args:{name:'审查新预算',amount:10},dependencies:['read']};
const transfer={id:'t',name:'转200',kind:'tool' as const,tool:'transfer_money',args:{name:'张伟',amount:200},dependencies:['read']};
async function pausedPlan(s:string,node:any){const result=await runSubmitPlan(userId,{goal:'审查',nodes:[{id:'read',name:'读',kind:'tool',tool:'get_balance',args:{},dependencies:[]},node]},{sessionId:s,runTool:async()=>{const row=await getTestPrisma().agentTask.findFirst({where:{sessionId:s},orderBy:{createdAt:'desc'}});await pauseTask(s,row!.id);return {ok:true,data:{balance:23580}};}});return result.data as any;}
it('a staggered concurrent resume does not repeat an already-effected node before its result persists',async()=>{
  const s=await session();const plan=await pausedPlan(s,budget);
  let reached!:()=>void;const atBoundary=new Promise<void>(r=>reached=r);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const first=resumeTask(s,plan.id,{runTool:async(tool,args)=>{const outcome=await runner(s)(tool,args);reached();await gate;return outcome;}});
  let second:any;
  try{await atBoundary;second=await post(taskPost,plan.id,{action:'resume'},s);}finally{release();await first;}
  const count=await getTestPrisma().budget.count({where:{name:'审查新预算'}});
  console.log('REVIEW staggered_resume',JSON.stringify({secondStatus:second.httpStatus,count}));
  expect(count).toBe(1);
});
it('two concurrent resumes of one gated node produce only one pending action',async()=>{
  const s=await session();const plan=await pausedPlan(s,transfer);
  const replies=await Promise.all([post(taskPost,plan.id,{action:'resume'},s),post(taskPost,plan.id,{action:'resume'},s)]);
  const rows=await getTestPrisma().pendingAction.findMany({where:{sessionId:s,toolName:'transfer_money'}});
  console.log('REVIEW gated_double_resume',JSON.stringify({statuses:replies.map(r=>r.httpStatus),actions:rows.map(r=>({id:r.id,status:r.status}))}));
  expect(rows.length).toBe(1);
});
it('cancelling a doubly-resumed plan revokes every action created for its node',async()=>{
  const s=await session();const plan=await pausedPlan(s,transfer);
  await Promise.all([post(taskPost,plan.id,{action:'resume'},s),post(taskPost,plan.id,{action:'resume'},s)]);
  const cancelled=await post(taskPost,plan.id,{action:'cancel'},s);
  const leftovers=await getTestPrisma().pendingAction.findMany({where:{sessionId:s,status:'pending'}});
  const confirmations=[];
  for(const row of leftovers)confirmations.push(await post(confirmPost,row.id,{},s,`/api/actions/${row.id}/confirm`));
  const total=await security.risk.computeDailyTransferTotal(userId);
  console.log('REVIEW orphan_after_cancel',JSON.stringify({cancelled:cancelled.data?.status,leftovers:leftovers.length,confirmed:confirmations.map(r=>r.data?.ok),total}));
  expect(total).toBe(0);
  expect(leftovers.length).toBe(0);
});
it('independent plans with identical tools and arguments each perform their own side effect',async()=>{
  const s=await session();const node={...budget,dependencies:[]};
  const results=await Promise.all([runSubmitPlan(userId,{goal:'计划A',nodes:[node]},{sessionId:s,runTool:runner(s)}),runSubmitPlan(userId,{goal:'计划B',nodes:[node]},{sessionId:s,runTool:runner(s)})]);
  const count=await getTestPrisma().budget.count({where:{name:'审查新预算'}});
  console.log('REVIEW independent_plans',JSON.stringify({planIds:results.map(r=>(r.data as any)?.id),statuses:results.map(r=>(r.data as any)?.status),count}));
  expect(count).toBe(2);
});
it('cancel blocks confirmation of an action minted before its node association persists',async()=>{
  const s=await session();let reached!:()=>void;const atBoundary=new Promise<void>(r=>reached=r);let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  let actionId='';
  const running=runSubmitPlan(userId,{goal:'转账',nodes:[{...transfer,dependencies:[]}]},{sessionId:s,runTool:async(tool,args)=>{const outcome=await runner(s)(tool,args);actionId=outcome.pendingActionId!;reached();await gate;return outcome;}});
  let cancelled:any,confirmed:any;
  try{await atBoundary;const task=await getTestPrisma().agentTask.findFirst({where:{sessionId:s}});cancelled=await post(taskPost,task!.id,{action:'cancel'},s);confirmed=await post(confirmPost,actionId,{},s,`/api/actions/${actionId}/confirm`);}
  finally{release();await running;}
  const total=await security.risk.computeDailyTransferTotal(userId);
  console.log('REVIEW unlinked_cancel',JSON.stringify({cancelled:cancelled.data?.status,confirmed:confirmed.data?.ok,total}));
  expect(total).toBe(0);
});
