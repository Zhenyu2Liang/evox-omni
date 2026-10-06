import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as taskControl from '@/agent/task-control';
import * as taskRepository from '@/lib/db/repositories/task';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查恢复',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirm(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
it('recovery of an executed limit change must preserve a later independently authorized limit',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const args={cardId:card.id,category:'娱乐',amount:1500};
 const result=await runSubmitPlan(userId,{goal:'旧限额调整',nodes:[{id:'limit',name:'调整限额',kind:'tool',tool:'set_card_limit',args,dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(taskRepository,'updateTaskNode').mockRejectedValueOnce(new Error('review: simulated node-result persistence failure'));
 const first=await confirm(action.id,s);spy.mockRestore();
 const later=await executeGatedTool({sessionId:s,userId,toolName:'set_card_limit',args:{...args,amount:500},userRequest:'现在把限额收紧到500'});const second=await confirm(later.pendingActionId!,s);
 const before=await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}});
 const resumed=await task(plan.id,'resume',s);const after=await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}});
 console.log('REVIEW_RECOVERY_REAPPLY',JSON.stringify({firstOk:first.ok,secondOk:second.ok,beforeResume:before?.amount,afterResume:after?.amount,planStatus:resumed.status}));
 expect(first.ok).toBe(true);expect(second.ok).toBe(true);expect(before?.amount).toBe(500);expect(after?.amount).toBe(500);expect(resumed.status).toBe('success');
});
it('a live old executor cannot overwrite the takeover executor completed result',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'接管测试',nodes:[{id:'read',name:'读余额',kind:'tool',tool:'get_balance',args:{},dependencies:[]},{id:'budget',name:'预算',kind:'tool',tool:'reserve_budget',args:{name:'接管预算',amount:10},dependencies:['read']}]},{sessionId:s,runTool:async()=>{const row=(await p.agentTask.findFirst({where:{sessionId:s}}))!;await taskControl.pauseTask(s,row.id);return {ok:true,data:{balance:23580}};}});
 const plan:any=result.data;const reached=deferred(),release=deferred();
 const oldRun=taskControl.resumeTask(s,plan.id,{runTool:async(tool,args,ctx)=>{await runner(s)(tool,args,ctx);reached.release();await release.promise;return {ok:false,error:'review: old executor late failure'};}});
 let takeover:any;
 try{await bounded(reached.promise);const expired=new Date(Date.now()-660000);await p.agentTask.update({where:{id:plan.id},data:{executionClaimedAt:expired}});await p.agentTaskNode.updateMany({where:{taskId:plan.id,status:'running'},data:{executionClaimedAt:expired}});takeover=await task(plan.id,'resume',s);}
 finally{release.release();await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:plan.id},include:{nodes:true}});const count=await p.budget.count({where:{userId,name:'接管预算'}});
 console.log('REVIEW_STALE_WRITER',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,nodeStatus:stored?.nodes.find(x=>x.nodeId==='budget')?.status,budgets:count}));
 expect(takeover.status).toBe('success');expect(count).toBe(1);expect(stored?.status).toBe('success');expect(stored?.nodes.find(x=>x.nodeId==='budget')?.status).toBe('success');
});
