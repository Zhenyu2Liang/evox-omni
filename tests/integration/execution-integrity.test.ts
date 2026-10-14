import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { toJson } from '@/lib/json';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as taskControl from '@/agent/task-control';
import * as taskRepository from '@/lib/db/repositories/task';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { securityGateway } from '@/security/security-gateway';
import { createTaskPersistence } from '@/agent/task-control';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'核查执行完整性',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirmRaw(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});return {status:res.status,body:await res.json()};}
async function confirm(id:string,s:string){const r=await confirmRaw(id,s);expect(r.status).toBe(200);return r.body.data;}
/** A claim timestamp older than `EXECUTION_CLAIM_TTL_MS` (600s), so a resume/retry may take the claim over. */
const expired=()=>new Date(Date.now()-660000);
const pauseOnRead=(s:string)=>({runTool:async()=>{const row=(await getTestPrisma().agentTask.findFirst({where:{sessionId:s}}))!;await taskControl.pauseTask(s,row.id);return {ok:true,data:{balance:'23580.00'}};}});

it('the initial submit executor cannot overwrite a takeover completed node',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();const reached=deferred(),release=deferred();let planId='';
 const oldRun=runSubmitPlan(userId,{goal:'首次执行接管',nodes:[{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'执行完整性首次接管预算',amount:'10'},dependencies:[]}]},{sessionId:s,runTool:async(tool,args,ctx)=>{planId=ctx.taskId;await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: initial executor late failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:planId},data:{executionClaimedAt:expired()}});takeover=await task(planId,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await taskRepository.getTask(planId);const node=stored?.nodes.find(x=>x.nodeId==='budget');const count=await p.budget.count({where:{userId,name:'执行完整性首次接管预算'}});
 console.log('REVIEW_EXEC_INITIAL_TAKEOVER',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,nodeStatus:node?.status,budgets:count}));
 expect(takeover.status).toBe('success');expect(count).toBe(1);expect(stored?.status).toBe('success');expect(node?.status).toBe('success');
});

it('an obsolete resumed executor cannot persist a late success over the takeover node result',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'过期执行者晚成功',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'执行完整性晚成功预算',amount:'10'},dependencies:['read']}]},{sessionId:s,...pauseOnRead(s)});
 const plan:any=result.data;const reached=deferred(),release=deferred();
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:true,data:{balance:'999.00'}};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired()}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired()}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await taskRepository.getTask(plan.id);const node=stored?.nodes.find(x=>x.nodeId==='budget');const count=await p.budget.count({where:{userId,name:'执行完整性晚成功预算'}});
 console.log('REVIEW_OBSOLETE_LATE_SUCCESS',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,nodeStatus:node?.status,nodeOutput:node?.output,budgets:count}));
 expect(takeover.status).toBe('success');expect(stored?.status).toBe('success');expect(node?.status).toBe('success');
 expect(node?.output??'').toContain('执行完整性晚成功预算');expect(node?.output??'').not.toContain('"balance":999');expect(count).toBe(1);
});

it('an obsolete resumed executor cannot mark a takeover completed node failed',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'过期执行者晚失败',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'执行完整性晚失败预算',amount:'10'},dependencies:['read']}]},{sessionId:s,...pauseOnRead(s)});
 const plan:any=result.data;const reached=deferred(),release=deferred();
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: obsolete failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired()}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired()}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await taskRepository.getTask(plan.id);const node=stored?.nodes.find(x=>x.nodeId==='budget');const count=await p.budget.count({where:{userId,name:'执行完整性晚失败预算'}});
 console.log('REVIEW_OBSOLETE_LATE_FAILURE',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,nodeStatus:node?.status,nodeError:node?.error,budgets:count}));
 expect(takeover.status).toBe('success');expect(stored?.status).toBe('success');expect(node?.status).toBe('success');expect(node?.error??'').not.toContain('obsolete failure');expect(count).toBe(1);
});

it('a stale node token cannot write a partial result after the takeover completed the node',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'过期节点令牌晚写入',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'执行完整性部分写入预算',amount:'10'},dependencies:['read']}]},{sessionId:s,...pauseOnRead(s)});
 const plan:any=result.data;const reached=deferred(),release=deferred();let capturedOldToken:string|undefined;
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:true,data:{balance:'999.00'}};}});
 let takeover:any;
 try{await bounded(reached.promise);capturedOldToken=(await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'budget'}}))?.executionToken??undefined;await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired()}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired()}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const store=createTaskPersistence(plan.id,{nodeToken:()=>capturedOldToken});
 await store.persistNode(plan.id,{id:'budget',name:'预算',status:'running',output:{partial:true},startedAt:Date.now()});
 const node=(await taskRepository.getTask(plan.id))?.nodes.find(x=>x.nodeId==='budget');
 console.log('REVIEW_STALE_NODE_TOKEN_PARTIAL',JSON.stringify({takeoverStatus:takeover?.status,capturedToken:typeof capturedOldToken,nodeStatus:node?.status,nodeOutput:node?.output}));
 expect(typeof capturedOldToken).toBe('string');expect(takeover.status).toBe('success');expect(node?.status).toBe('success');expect(node?.output??'').not.toContain('partial');
});

it('an obsolete resumed executor cannot skip a dependent already completed by the takeover',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'依赖跳过写入围栏',nodes:[{id:'read',name:'读取',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'执行完整性依赖预算',amount:'10'},dependencies:['read']},{id:'tail',name:'收尾',kind:'note',dependencies:['budget']}]},{sessionId:s,...pauseOnRead(s)});
 const plan:any=result.data;const reached=deferred(),release=deferred();
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: obsolete failure blocks dependency'};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired()}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired()}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await taskRepository.getTask(plan.id);
 console.log('REVIEW_OBSOLETE_DEPENDENT_SKIP',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,budgetStatus:stored?.nodes.find(x=>x.nodeId==='budget')?.status,tailStatus:stored?.nodes.find(x=>x.nodeId==='tail')?.status}));
 expect(takeover.status).toBe('success');expect(stored?.status).toBe('success');
 expect(stored?.nodes.find(x=>x.nodeId==='budget')?.status).toBe('success');expect(stored?.nodes.find(x=>x.nodeId==='tail')?.status).toBe('success');
});

it('a stored successful result stays consistent when the separate terminal status write fails',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const result=await runSubmitPlan(userId,{goal:'结果与状态写入窗口',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args:{cardId:card.id,category:'娱乐',amount:'1500'},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(securityGateway,'recordActionResult').mockRejectedValueOnce(new Error('review: terminal status persistence failed'));
 const first=await confirm(action.id,s);spy.mockRestore();
 const pending=(await p.pendingAction.findUnique({where:{id:action.id}}))!;
 const resumed=await task(plan.id,'resume',s);const repeated=await confirmRaw(action.id,s);
 const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amountMinor;const rows=await p.cardLimit.count({where:{cardId:card.id,category:'娱乐'}});
 const hasResult=pending.resultJson!==null&&pending.resultJson!==undefined;const consistent=(pending.status==='executed')===hasResult;
 console.log('REVIEW_RESULT_STATUS_ATOMIC',toJson({firstOk:first.ok,firstStatus:first.status,actionStatus:pending.status,hasResult,savedOk:JSON.parse(pending.resultJson??'{}').ok,consistent,planStatus:resumed.status,repeat:repeated.body.data?.ok,amount,rows}));
 expect(first.status).toBe('executed');expect(pending.status).toBe('executed');expect(['confirmed','waiting_confirmation']).not.toContain(pending.status);
 expect(hasResult).toBe(true);expect(consistent).toBe(true);expect(JSON.parse(pending.resultJson??'{}').ok).toBe(true);
 expect(amount).toBe(150000n);expect(rows).toBe(1);expect(resumed.status).toBe('success');expect(repeated.status).toBe(200);expect(repeated.body.data?.ok).toBe(false);
});

it('the result payload and the terminal status are written in one atomic transaction',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'Atomic result and status',nodes:[{id:'limit',name:'Set card limit',kind:'tool',tool:'set_card_limit',args:{cardId:'card_credit',category:'\u5a31\u4e50',amount:'1500'},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: atomic status write failed'));
 const failed=await confirmRaw(action.id,s);spy.mockRestore();
 const after=(await p.pendingAction.findUnique({where:{id:action.id}}))!;
 const retry=await confirmRaw(action.id,s);
 const limits=await p.cardLimit.findMany({where:{cardId:'card_credit',category:'\u5a31\u4e50'}});
 const hasResult=after.resultJson!==null&&after.resultJson!==undefined;const consistent=(after.status==='executed')===hasResult;
 console.log('REVIEW_ATOMIC_RESULT_STATUS',JSON.stringify({failureHttp:failed.status,failureOk:failed.body?.ok,actionStatus:after.status,hasResult,consistent,retryHttp:retry.status,retryOk:retry.body.data?.ok}));
 expect(failed.status).toBeGreaterThanOrEqual(400);expect(failed.body?.ok).toBe(false);
 expect(hasResult).toBe(false);expect(after.status==='executed').toBe(false);expect(consistent).toBe(true);
 expect(retry.body.data?.ok).toBe(false);expect(limits).toHaveLength(1);expect(limits[0].amountMinor).toBe(150000n);
});
