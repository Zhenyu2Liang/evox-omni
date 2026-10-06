import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as taskRepository from '@/lib/db/repositories/task';
import * as taskControl from '@/agent/task-control';
import { securityGateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'核查恢复',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirmRaw(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});return {status:res.status,body:await res.json()};}
async function confirm(id:string,s:string){const r=await confirmRaw(id,s);expect(r.status).toBe(200);return r.body.data;}

it('pre-upgrade executed actions without stored results must never overwrite a later authorized limit',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const args={cardId:card.id,category:'娱乐',amount:1500};
 const result=await runSubmitPlan(userId,{goal:'遗留限额节点',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args,dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(taskRepository,'updateTaskNode').mockRejectedValueOnce(new Error('review: node outcome persistence failed'));
 const first=await confirm(action.id,s);spy.mockRestore();
 // Reproduce a legitimate pre-upgrade row: new nullable column has no historical payload.
 await p.pendingAction.update({where:{id:action.id},data:{resultJson:null}});
 const later=await executeGatedTool({sessionId:s,userId,toolName:'set_card_limit',args:{...args,amount:500},userRequest:'后续独立收紧限额'});await confirm(later.pendingActionId!,s);
 const before=await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}});
 const resumed=await task(plan.id,'resume',s);const after=await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}});
 console.log('REVIEW_LEGACY_RESULT_REAPPLY',JSON.stringify({firstOk:first.ok,before:before?.amount,after:after?.amount,planStatus:resumed.status}));
 expect(first.ok).toBe(true);expect(before?.amount).toBe(500);expect(after?.amount).toBe(500);
});

it('the initial submit executor cannot overwrite a takeover completed node',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const reached=deferred(),release=deferred();let planId='';
 const oldRun=runSubmitPlan(userId,{goal:'首次执行接管',nodes:[{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'首次接管预算',amount:10},dependencies:[]}]},{sessionId:s,runTool:async(tool,args,ctx)=>{planId=ctx.taskId;await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: initial executor late failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:planId},data:{executionClaimedAt:new Date(Date.now()-660000)}});takeover=await task(planId,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:planId},include:{nodes:true}});const count=await p.budget.count({where:{userId,name:'首次接管预算'}});
 console.log('REVIEW_INITIAL_STALE_WRITER',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,nodeStatus:stored?.nodes[0]?.status,budgets:count}));
 expect(takeover.status).toBe('success');expect(count).toBe(1);expect(stored?.status).toBe('success');expect(stored?.nodes[0]?.status).toBe('success');
});

it('a saved successful result must remain recoverable if the separate terminal status write fails',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const result=await runSubmitPlan(userId,{goal:'结果与状态写入窗口',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args:{cardId:card.id,category:'娱乐',amount:1500},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(securityGateway,'recordActionResult').mockRejectedValueOnce(new Error('review: terminal status persistence failed'));
 const first=await confirmRaw(action.id,s);spy.mockRestore();
 const pending=await p.pendingAction.findUnique({where:{id:action.id}});const resumed=await task(plan.id,'resume',s);const repeated=await confirmRaw(action.id,s);
 const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 console.log('REVIEW_RESULT_STATUS_GAP',JSON.stringify({firstHttp:first.status,actionStatus:pending?.status,savedOk:JSON.parse(pending?.resultJson??'{}').ok,planStatus:resumed.status,repeat:repeated.body.data?.ok,amount}));
 expect(amount).toBe(1500);expect(JSON.parse(pending?.resultJson??'{}').ok).toBe(true);expect(resumed.status).toBe('success');
});

it('an obsolete resumed executor must not skip a dependent already completed by the takeover',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'依赖跳过写入围栏',nodes:[{id:'read',name:'读取',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'依赖接管预算',amount:10},dependencies:['read']},{id:'tail',name:'收尾',kind:'note',dependencies:['budget']}]},{sessionId:s,runTool:async()=>{const row=(await p.agentTask.findFirst({where:{sessionId:s}}))!;await taskControl.pauseTask(s,row.id);return {ok:true,data:{balance:23580}};}});
 const plan:any=result.data;const reached=deferred(),release=deferred();
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: obsolete failure blocks dependency'};}});
 let takeover:any;
 try{await bounded(reached.promise);const expired=new Date(Date.now()-660000);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:plan.id},include:{nodes:true}});
 console.log('REVIEW_STALE_DEPENDENT_WRITE',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,budgetStatus:stored?.nodes.find(x=>x.nodeId==='budget')?.status,tailStatus:stored?.nodes.find(x=>x.nodeId==='tail')?.status}));
 expect(takeover.status).toBe('success');expect(stored?.status).toBe('success');expect(stored?.nodes.find(x=>x.nodeId==='budget')?.status).toBe('success');expect(stored?.nodes.find(x=>x.nodeId==='tail')?.status).toBe('success');
});
