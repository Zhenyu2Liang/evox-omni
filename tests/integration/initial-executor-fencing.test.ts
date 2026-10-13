import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'核查初始执行者接管',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}

// DEFECT 1: an INITIAL `submit_plan` executor whose plan claim is taken over by a concurrent
// `resume` must stop at its next node boundary. This spec extends the frozen base
// (`integration/confirmation-continuation.test.ts` case 1, which asserts only `oldSuccessorCalls`) with the
// FENCED-OUT PUBLISH + DB/RETURN CONSISTENCY + SIDE-EFFECT EXACTNESS invariants that the frozen
// base does NOT cover: the zombie must publish NEITHER a stale node event NOR a stale plan
// snapshot, the persisted plan must agree with the RETURNED takeover plan, and the zombie's own
// return must not claim a successor success the DB does not have.
it('an INITIAL submit executor publishes no stale node/plan progress and stays DB-consistent after losing its plan claim',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const reached=deferred(),release=deferred();
 let planId='';let oldSuccessorCalls=0;let afterTakeover=false;
 const lateNodeUpdates:any[]=[];const latePlanSnapshots:any[]=[];
 const oldRun=runSubmitPlan(userId,{goal:'首次提交接管一致性',nodes:[{id:'first',name:'首次一致性第一预算',kind:'tool',tool:'reserve_budget',args:{name:'首次一致性第一预算',amount:'10'},dependencies:[]},{id:'second',name:'首次一致性第二预算',kind:'tool',tool:'reserve_budget',args:{name:'首次一致性第二预算',amount:'20'},dependencies:['first']}]},{sessionId:s,onNodeUpdate:node=>{if(afterTakeover)lateNodeUpdates.push(node);},onPlanUpdate:plan=>{if(afterTakeover)latePlanSnapshots.push(plan);},runTool:async(tool,args,ctx)=>{planId=ctx.taskId;const value=await runner(s)(tool,args,ctx);if(ctx.nodeId==='first'){reached.release();await release.promise;}else{oldSuccessorCalls++;}return value;}});
 let takeover:any,oldResult:any,budgetsAtTakeover=0;
 try{
  await bounded(reached.promise);
  // Age the plan's ownership past `EXECUTION_CLAIM_TTL_MS` (600000ms) so the concurrent `resume`
  // takes the plan claim over while the zombie is still blocked inside its FIRST node's tool.
  await p.agentTask.update({where:{id:planId},data:{executionClaimedAt:new Date(Date.now()-660000)}});
  takeover=await task(planId,'resume',s);
  budgetsAtTakeover=await p.budget.count({where:{userId,name:{in:['首次一致性第一预算','首次一致性第二预算']}}});
  // Only NOW start collecting: everything the zombie publishes after this point is stale.
  afterTakeover=true;
 }finally{release.release();oldResult=await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:planId},include:{nodes:true}});
 const budgets=await p.budget.count({where:{userId,name:{in:['首次一致性第一预算','首次一致性第二预算']}}});
 const storedNodeStatuses=(stored?.nodes??[]).map(n=>`${n.nodeId}:${n.status}`).sort();
 const takeoverNodeStatuses=((takeover.results??[]) as any[]).map(r=>`${r.id}:${r.status}`).sort();
 const storedById:Record<string,string>=Object.fromEntries((stored?.nodes??[]).map(n=>[n.nodeId,n.status]));
 const oldResults:any[]=oldResult.data?.results??[];const oldSuccessor=oldResults.find(r=>r.id==='second');
 console.log('REVIEW_INITIAL_FENCING_CONSISTENCY',JSON.stringify({takeoverStatus:takeover?.status,oldStatus:oldResult.data?.status,oldSuccessorCalls,lateNodeUpdates:lateNodeUpdates.length,latePlanSnapshots:latePlanSnapshots.length,storedStatus:stored?.status,storedNodeStatuses,takeoverNodeStatuses,oldSuccessorStatus:oldSuccessor?.status,budgets,budgetsAtTakeover}));
 // (1) The concurrent takeover completes and the zombie launches ZERO successor tool calls.
 expect(takeover.status).toBe('success');expect(oldSuccessorCalls).toBe(0);
 // (2) NO stale progress event: the fenced-out zombie publishes NEITHER a node status NOR a plan snapshot.
 expect(lateNodeUpdates).toHaveLength(0);expect(latePlanSnapshots).toHaveLength(0);
 // (3) DB/RETURN CONSISTENCY: the persisted plan agrees EXACTLY with the RETURNED takeover snapshot...
 expect(stored?.status).toBe(takeover.status);
 expect(storedNodeStatuses).toEqual(takeoverNodeStatuses);
 // ...and the zombie's OWN return never claims a success the DB does not have.
 oldResults.filter(r=>r.status==='success').forEach(r=>expect(storedById[r.id]).toBe('success'));
 expect(oldSuccessor?.status).not.toBe('success');
 // (4) Side-effect exactness: exactly the two nodes' budgets, no duplicate from the zombie.
 expect(budgets).toBe(2);expect(budgets).toBe(budgetsAtTakeover);
});
