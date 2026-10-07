import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { securityGateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'核查执行完整性',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirmRaw(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});return {status:res.status,body:await res.json()};}

it('an INITIAL submit executor must stop all successor tool calls after losing its plan claim',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const reached=deferred(),release=deferred();let planId='';let oldSuccessorCalls=0;let afterTakeover=false;const lateNodeStatuses:string[]=[];
 const oldRun=runSubmitPlan(userId,{goal:'首次提交后续节点接管',nodes:[{id:'first',name:'第一预算',kind:'tool',tool:'reserve_budget',args:{name:'首次接管第一预算',amount:10},dependencies:[]},{id:'second',name:'第二预算',kind:'tool',tool:'reserve_budget',args:{name:'首次接管第二预算',amount:20},dependencies:['first']}]},{sessionId:s,onNodeUpdate:node=>{if(afterTakeover)lateNodeStatuses.push(node.status);},runTool:async(tool,args,ctx)=>{planId=ctx.taskId;const value=await runner(s)(tool,args,ctx);if(ctx.nodeId==='first'){reached.release();await release.promise;}else{oldSuccessorCalls++;}return value;}});
 let takeover:any,oldResult:any;
 try{await bounded(reached.promise);await p.agentTask.update({where:{id:planId},data:{executionClaimedAt:new Date(Date.now()-660000)}});takeover=await task(planId,'resume',s);afterTakeover=true;}
 finally{release.release();oldResult=await oldRun;}
 const stored=await p.agentTask.findUnique({where:{id:planId},include:{nodes:true}});
 console.log('REVIEW_INITIAL_SUCCESSOR_CONTINUES',JSON.stringify({takeoverStatus:takeover?.status,finalStatus:stored?.status,oldStatus:oldResult.data?.status,oldSuccessorCalls,lateNodeStatuses,budgets:await p.budget.count({where:{userId,name:{in:['首次接管第一预算','首次接管第二预算']}}})}));
 expect(takeover.status).toBe('success');expect(oldSuccessorCalls).toBe(0);expect(lateNodeStatuses).toHaveLength(0);
});

async function liveConfirmationProbe(duplicate:boolean){
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;
 const seeded=await runSubmitPlan(userId,{goal:'并发确认活性标记',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args:{cardId:card.id,category:'娱乐',amount:1500},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=seeded.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;const reached=deferred(),release=deferred();
 const original=securityGateway.authorizeAction.bind(securityGateway);let held=false;
 const spy=vi.spyOn(securityGateway,'authorizeAction').mockImplementation(async(id,opts)=>{const value=await original(id,opts);if(value.ok&&!held){held=true;reached.release();await release.promise;}return value;});
 const firstRun=confirmRaw(action.id,s);let second:any,resumed:any,during:any,first:any;
 try{await bounded(reached.promise);if(duplicate)second=await confirmRaw(action.id,s);resumed=await task(plan.id,'resume',s);during=await p.pendingAction.findUnique({where:{id:action.id}});}
 finally{release.release();first=await firstRun;spy.mockRestore();}
 const after=await p.agentTask.findUnique({where:{id:plan.id},include:{nodes:true}});const afterAction=await p.pendingAction.findUnique({where:{id:action.id}});const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 console.log('REVIEW_LIVE_CONFIRMATION_MARKER',JSON.stringify({duplicate,duplicateOk:second?.body.data?.ok,duringStatus:during?.status,resumedStatus:resumed?.status,firstOk:first?.body.data?.ok,finalAction:afterAction?.status,finalPlan:after?.status,finalNode:after?.nodes[0]?.status,amount}));
 expect(during?.status).toBe('confirmed');expect(resumed.status).toBe('waiting_confirmation');expect(first.body.data?.ok).toBe(true);expect(after?.nodes[0]?.status).toBe('success');
}

it('a rejected duplicate confirm must not clear the first still-live continuation marker',()=>liveConfirmationProbe(true));
it('without a duplicate request the live confirmation is retained and finishes normally',()=>liveConfirmationProbe(false));

it('a STANDALONE transferred action must recover or visibly enter reconciliation after result persistence failure',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const gated=await executeGatedTool({sessionId:s,userId,toolName:'transfer_money',args:{name:'张伟',amount:200},userRequest:'给张伟转200元'});
 const id=gated.pendingActionId!;expect(id).toBeTruthy();
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: standalone result transaction failed'));
 const first=await confirmRaw(id,s);spy.mockRestore();const repeated=await confirmRaw(id,s);
 const listedResponse=await actionsGet(new NextRequest('http://localhost/api/actions',{headers:{cookie:`banking_session=${s}`}}));const listed=await listedResponse.json();
 const stored=await p.pendingAction.findUnique({where:{id}});const balance=(await p.account.findFirst({where:{userId,type:'CHECKING'}}))?.balance;const debitCount=await p.transaction.count({where:{userId,amount:-200,counterpartyId:'contact_zhangwei'}});
 console.log('REVIEW_STANDALONE_RESULT_GAP',JSON.stringify({firstHttp:first.status,repeatedOk:repeated.body.data?.ok,actionStatus:stored?.status,taskId:stored?.taskId,result:stored?.resultJson,visibleActions:listed.data?.length,balance,debitCount}));
 expect(first.status).toBe(500);expect(debitCount).toBe(1);expect(balance).toBe(23380);expect(stored?.status).not.toBe('confirmed');
});
