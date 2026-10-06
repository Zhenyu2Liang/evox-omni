import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as taskControl from '@/agent/task-control';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import * as taskRepository from '@/lib/db/repositories/task';
import { securityGateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'核查接管与恢复',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirmRaw(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});return {status:res.status,body:await res.json()};}

it('a replaced plan executor must not reclaim and overwrite a completed successor node',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const seeded=await runSubmitPlan(userId,{goal:'接管后后续节点',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'first',name:'第一预算',kind:'tool',tool:'reserve_budget',args:{name:'接管第一预算',amount:10},dependencies:['read']},{id:'second',name:'第二预算',kind:'tool',tool:'reserve_budget',args:{name:'接管第二预算',amount:20},dependencies:['first']}]},{sessionId:s,runTool:async()=>{const row=(await p.agentTask.findFirst({where:{sessionId:s}}))!;await taskControl.pauseTask(s,row.id);return {ok:true,data:{balance:23580}};}});
 const plan:any=seeded.data;const reached=deferred(),release=deferred();let oldSuccessorCalls=0;
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{const value=await runner(s)(tool,args,ctx);if(ctx.nodeId==='first'){reached.release();await release.promise;return value;}oldSuccessorCalls++;return {ok:false,error:'review: obsolete executor successor failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);const expired=new Date(Date.now()-660000);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:plan.id},include:{nodes:true}});
 console.log('REVIEW_OBSOLETE_SUCCESSOR_RECLAIM',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,secondStatus:stored?.nodes.find(x=>x.nodeId==='second')?.status,oldSuccessorCalls,budgets:await p.budget.count({where:{userId,name:{in:['接管第一预算','接管第二预算']}}})}));
 expect(takeover.status).toBe('success');expect(oldSuccessorCalls).toBe(0);expect(stored?.nodes.find(x=>x.nodeId==='second')?.status).toBe('success');
});

it('an obsolete initial executor must not publish a failed plan update after takeover success',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const reached=deferred(),release=deferred();let planId='';let afterTakeover=false;const lateUpdates:any[]=[];
 const oldRun=runSubmitPlan(userId,{goal:'过期进度事件',nodes:[{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'过期事件预算',amount:10},dependencies:[]}]},{sessionId:s,onPlanUpdate:async(plan)=>{if(afterTakeover)lateUpdates.push(plan);},runTool:async(tool,args,ctx)=>{planId=ctx.taskId;await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: obsolete stream failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:planId},data:{executionClaimedAt:new Date(Date.now()-660000)}});takeover=await task(planId,'resume',s);afterTakeover=true;}
 finally{release.release();await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:planId},include:{nodes:true}});
 console.log('REVIEW_OBSOLETE_PROGRESS_EVENT',JSON.stringify({takeoverStatus:takeover?.status,persistedStatus:stored?.nodes[0]?.status,lateStatuses:lateUpdates.map(x=>x.results.find((r:any)=>r.id==='budget')?.status)}));
 expect(takeover.status).toBe('success');expect(stored?.nodes[0]?.status).toBe('success');expect(lateUpdates).toHaveLength(0);
});

it('a committed business effect must not wedge indefinitely when its result transaction rolls back',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'结果事务回滚恢复',nodes:[{id:'card',name:'虚拟卡',kind:'tool',tool:'apply_virtual_card',args:{label:'结果回滚探针'},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: transaction status write failed'));
 const first=await confirmRaw(action.id,s);spy.mockRestore();
 const after=await p.pendingAction.findUnique({where:{id:action.id}});const resumed=await task(plan.id,'resume',s);const resumedAgain=await task(plan.id,'resume',s);
 console.log('REVIEW_RESULT_TX_ROLLBACK_WEDGE',JSON.stringify({firstHttp:first.status,actionStatus:after?.status,result:after?.resultJson,firstResume:resumed.status,secondResume:resumedAgain.status,cards:await p.card.count({where:{userId,type:'VIRTUAL'}})}));
 expect(await p.card.count({where:{userId,type:'VIRTUAL'}})).toBe(1);expect(resumedAgain.status).not.toBe('waiting_confirmation');
});

it('recovery of a persisted failed result must finalize the action as failed rather than executed',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const result=await runSubmitPlan(userId,{goal:'旧失败结果恢复',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args:{cardId:card.id,category:'娱乐',amount:1500},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 await securityGateway.authorizeAction(action.id,{sessionId:s,userId});
 // Legitimate legacy interruption: previous versions persisted failed tool result before status.
 await p.pendingAction.update({where:{id:action.id},data:{resultJson:JSON.stringify({ok:false,error:'review: actual business failure'})}});
 const resumed=await task(plan.id,'resume',s);const after=await p.pendingAction.findUnique({where:{id:action.id}});
 console.log('REVIEW_FAILED_RESULT_FINALIZATION',JSON.stringify({planStatus:resumed.status,actionStatus:after?.status,resultOk:JSON.parse(after?.resultJson??'{}').ok}));
 expect(resumed.status).toBe('failed');expect(after?.status).toBe('failed');
});

it('legacy recovery is safe when the result transaction genuinely fails, without re-applying a later authorized limit',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;const args={cardId:card.id,category:'娱乐',amount:1500};
 const result=await runSubmitPlan(userId,{goal:'实际遗留结果恢复',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args,dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result transaction write injection'));// faults the REAL result+status $transaction write in executeAuthorizedAction (the old taskRepository.updateTaskNode fault never hit this path)
 await confirmRaw(action.id,s);const faultCalls=spy.mock.calls.length;spy.mockRestore();
 const nodeAfterFault=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});const resultAfterFault=(await p.pendingAction.findUnique({where:{id:action.id}}))?.resultJson;expect(faultCalls).toBeGreaterThanOrEqual(1);expect(nodeAfterFault?.status).not.toBe('success');expect(resultAfterFault).toBeNull();
 // Force the actual pre-upgrade gap: committed side effect, absent result, incomplete persisted node.
 await p.pendingAction.update({where:{id:action.id},data:{resultJson:null}});
 await p.agentTaskNode.updateMany({where:{taskId:plan.id,nodeId:'limit'},data:{status:'running',output:null,error:null}});
 await p.agentTask.update({where:{id:plan.id},data:{status:'running'}});
 const later=await executeGatedTool({sessionId:s,userId,toolName:'set_card_limit',args:{...args,amount:500},userRequest:'新限额500'});await confirmRaw(later.pendingActionId!,s);
 const resumed=await task(plan.id,'resume',s);const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 console.log('REVIEW_LEGACY_GUARD_COVERAGE',JSON.stringify({faultCalls,nodeAfterFault:nodeAfterFault?.status,resultAbsentAfterFault:resultAfterFault===null,recoveredPlanStatus:resumed.status,amount}));
 expect(amount).toBe(500);expect(resumed.status).toBe('failed');expect(resumed.results[0].error).toContain('人工核对');
});
