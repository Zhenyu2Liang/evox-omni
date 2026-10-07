import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as taskControl from '@/agent/task-control';
import * as taskRepository from '@/lib/db/repositories/task';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { redeemInvestment } from '@/banking-sdk/investment';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查恢复',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirm(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}

it('resume recovers an already-executed gated node after its plan callback fails',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'开卡后预留预算',nodes:[{id:'card',name:'开卡',kind:'tool',tool:'apply_virtual_card',args:{label:'恢复测试'},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'恢复预算',amount:10},dependencies:['card']}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(taskRepository,'updateTaskNode').mockRejectedValueOnce(new Error('review: simulated node-result persistence failure'));
 const response=await confirm(action.id,s);spy.mockRestore();
 const resumed=await task(plan.id,'resume',s);const repeated=await confirm(action.id,s);const resumedAgain=await task(plan.id,'resume',s);
 const cards=await p.card.count({where:{userId,type:'VIRTUAL'}});const budgets=await p.budget.count({where:{userId,name:'恢复预算'}});const stored=await p.pendingAction.findUnique({where:{id:action.id}});
 console.log('REVIEW_EXECUTED_NODE_RECOVERY',JSON.stringify({responseOk:response.ok,responseStatus:response.status,actionStatus:stored?.status,firstResume:resumed.status,repeatConfirmOk:repeated.ok,secondResume:resumedAgain.status,cards,budgets}));
 expect(response.ok).toBe(true);expect(cards).toBe(1);expect(resumedAgain.status).toBe('success');expect(budgets).toBe(1);
});

it('resume can recover a persisted executor claim whose owner died long ago',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'暂停后预留预算',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'崩溃恢复预算',amount:10},dependencies:['read']}]},{sessionId:s,runTool:async()=>{const row=(await p.agentTask.findFirst({where:{sessionId:s}}))!;await taskControl.pauseTask(s,row.id);return {ok:true,data:{balance:23580}};}});
 const plan:any=result.data;
 await p.agentTask.update({where:{id:plan.id},data:{executionToken:'dead-process-claim',executionClaimedAt:new Date('2000-01-01T00:00:00Z')}});
 const resumed=await task(plan.id,'resume',s);const stored=await p.agentTask.findUnique({where:{id:plan.id}});const budgets=await p.budget.count({where:{userId,name:'崩溃恢复预算'}});
 console.log('REVIEW_STALE_EXECUTOR_CLAIM',JSON.stringify({status:resumed.status,token:stored?.executionToken,claimedAt:stored?.executionClaimedAt,budgets}));
 expect(resumed.status).toBe('success');expect(budgets).toBe(1);
});

it('redemption same-key concurrency replays the exact result and distinct keys are refused',async()=>{
 const p=getTestPrisma();const input={userId,holdingId:'holding_wenjiana',idempotencyKey:'review-same-key'};
 const results=await Promise.all([redeemInvestment(input),redeemInvestment(input)]);expect(results[1]).toEqual(results[0]);
 await expect(redeemInvestment({...input,idempotencyKey:'review-different-key'})).rejects.toMatchObject({code:'CONFLICT'});
 expect((await p.account.findFirst({where:{userId,type:'CHECKING'}}))!.balance).toBe(28630);
});
