import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'结果恢复',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirmRaw(id:string,s:string){const res=await confirmPost(new NextRequest(`http://localhost/api/actions/${id}/confirm`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:'{}'}),{params:Promise.resolve({id})});return {status:res.status,body:await res.json()};}

/**
 * Reproduce the "side effect posted, result transaction rolled back" wedge on a PLAN-NODE gated
 * action, then leave a PERSISTED success `resultJson` on the still-`confirmed` action — the exact
 * state a recovery pass must resolve WITHOUT re-invoking the tool.
 *
 * Steps: park a `set_card_limit` ¥1500 node (YELLOW) → fault the confirm's atomic
 * `resultJson`+status transaction (via `setPendingActionStatus`) so the SDK side effect is committed
 * exactly once while the action stays `confirmed` with `resultJson=null` → independently tighten the
 * SAME category limit to ¥500 through a standalone action (so a re-invocation of ¥1500 would be
 * observable) → persist the node's true executed result.
 */
async function wedgeSuccessRecovery(s:string){
 const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;const args={cardId:card.id,category:'娱乐',amount:1500};
 const seeded=await runSubmitPlan(userId,{goal:'成功结果恢复',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args,dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=seeded.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result transaction write injection'));
 const first=await confirmRaw(action.id,s);const faultCalls=spy.mock.calls.length;spy.mockRestore();
 const afterFault=await p.pendingAction.findUnique({where:{id:action.id}});const nodeAfterFault=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});
 const later=await executeGatedTool({sessionId:s,userId,toolName:'set_card_limit',args:{...args,amount:500},userRequest:'后续独立收紧'});await confirmRaw(later.pendingActionId!,s);
 const limitAfterLater=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 await p.pendingAction.update({where:{id:action.id},data:{resultJson:JSON.stringify({ok:true,data:{cardId:card.id,category:'娱乐',amount:1500},summary:'限额已调整'})}});
 return {p,card,plan,action,first,faultCalls,afterFault,nodeAfterFault,limitAfterLater};
}

it('SUCCESS-result recovery applies the side effect exactly once without re-invoking the tool',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 const {p,card,plan,action,first,faultCalls,afterFault,nodeAfterFault,limitAfterLater}=await wedgeSuccessRecovery(s);
 const resumed=await task(plan.id,'resume',s);
 const finalAction=await p.pendingAction.findUnique({where:{id:action.id}});const finalNode=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 console.log('REVIEW_RESULT_RECOVERY_SUCCESS',JSON.stringify({firstHttp:first.status,faultCalls,afterFault:afterFault?.status,resultAfterFault:afterFault?.resultJson,nodeAfterFault:nodeAfterFault?.status,laterLimit:limitAfterLater,resumed:resumed.status,actionStatus:finalAction?.status,nodeStatus:finalNode?.status,amount}));
 expect(faultCalls).toBeGreaterThanOrEqual(1);expect(afterFault?.status).toBe('confirmed');expect(afterFault?.resultJson).toBeNull();expect(nodeAfterFault?.status).not.toBe('success');
 expect(limitAfterLater).toBe(500);expect(resumed.status).toBe('success');expect(finalAction?.status).toBe('executed');expect(finalNode?.status).toBe('success');expect(amount).toBe(500);
});

it('FAILED-result finalization marks the action, node and plan failed and never executed',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();const card=(await p.card.findFirst({where:{userId,type:'CREDIT'}}))!;const args={cardId:card.id,category:'娱乐',amount:1500};
 const seeded=await runSubmitPlan(userId,{goal:'失败结果定案',nodes:[{id:'limit',name:'限额',kind:'tool',tool:'set_card_limit',args,dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=seeded.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result transaction write injection'));
 const first=await confirmRaw(action.id,s);const faultCalls=spy.mock.calls.length;spy.mockRestore();
 await p.pendingAction.update({where:{id:action.id},data:{resultJson:JSON.stringify({ok:false,error:'review: actual business failure'})}});
 const resumed=await task(plan.id,'resume',s);
 const after=await p.pendingAction.findUnique({where:{id:action.id}});const node=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});
 console.log('REVIEW_RESULT_RECOVERY_FAILED',JSON.stringify({firstHttp:first.status,faultCalls,resumed:resumed.status,actionStatus:after?.status,nodeStatus:node?.status,resultOk:JSON.parse(after?.resultJson??'{}').ok}));
 expect(faultCalls).toBeGreaterThanOrEqual(1);expect(resumed.status).toBe('failed');expect(after?.status).toBe('failed');expect(after?.status).not.toBe('executed');expect(node?.status).toBe('failed');
});

it('repeat recovery is idempotent — the side effect is applied exactly once',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 const {p,card,plan,action}=await wedgeSuccessRecovery(s);
 const first=await task(plan.id,'resume',s);const second=await task(plan.id,'resume',s);
 const finalAction=await p.pendingAction.findUnique({where:{id:action.id}});const finalNode=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;const parked=await p.pendingAction.count({where:{sessionId:s,nodeId:'limit'}});
 console.log('REVIEW_RESULT_RECOVERY_IDEMPOTENT',JSON.stringify({firstResume:first.status,secondResume:second.status,actionStatus:finalAction?.status,nodeStatus:finalNode?.status,amount,parked}));
 expect(first.status).toBe('success');expect(second.status).toBe('success');expect(finalAction?.status).toBe('executed');expect(finalNode?.status).toBe('success');expect(amount).toBe(500);expect(parked).toBe(1);
});

it('concurrent recovery applies the side effect exactly once',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 const {p,card,plan,action}=await wedgeSuccessRecovery(s);
 const gate=deferred();const firstRun=task(plan.id,'resume',s);const secondRun=gate.promise.then(()=>task(plan.id,'resume',s));gate.release();
 const both=Promise.all([firstRun,secondRun]);await bounded(both);const [first,second]=await both;
 const finalAction=await p.pendingAction.findUnique({where:{id:action.id}});const finalNode=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});const stored=await p.agentTask.findUnique({where:{id:plan.id}});const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;const parked=await p.pendingAction.count({where:{sessionId:s,nodeId:'limit'}});const executed=await p.pendingAction.count({where:{sessionId:s,nodeId:'limit',status:'executed'}});
 console.log('REVIEW_RESULT_RECOVERY_CONCURRENT',JSON.stringify({firstResume:first.status,secondResume:second.status,planStatus:stored?.status,actionStatus:finalAction?.status,nodeStatus:finalNode?.status,amount,parked,executed}));
 expect(parked).toBe(1);expect(executed).toBe(1);expect(finalAction?.status).toBe('executed');expect(finalNode?.status).toBe('success');expect(stored?.status).toBe('success');expect(amount).toBe(500);
});

it('recovery after a simulated process restart is driven purely from persisted server state',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 const {p,card,plan,action}=await wedgeSuccessRecovery(s);
 // Simulate the owning process having died: the parked node's in-memory link is gone and the plan
 // is left `running` with a not-yet-settled node.
 await p.agentTaskNode.updateMany({where:{taskId:plan.id,nodeId:'limit'},data:{status:'running',output:null}});
 await p.agentTask.update({where:{id:plan.id},data:{status:'running'}});
 // Re-read FRESH from the DB (no in-process handles are reused) and drive recovery through the
 // REAL route handler only.
 const freshAction=await getTestPrisma().pendingAction.findUnique({where:{id:action.id}});const freshPlan=await getTestPrisma().agentTask.findUnique({where:{id:plan.id},include:{nodes:true}});
 const resumed=await task(plan.id,'resume',s);
 const after=await p.pendingAction.findUnique({where:{id:action.id}});const node=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'limit'}});const amount=(await p.cardLimit.findFirst({where:{cardId:card.id,category:'娱乐'}}))?.amount;
 console.log('REVIEW_RESULT_RECOVERY_RESTART',JSON.stringify({freshActionStatus:freshAction?.status,freshResultJson:freshAction?.resultJson,freshPlanStatus:freshPlan?.status,freshNodeStatus:freshPlan?.nodes.find(n=>n.nodeId==='limit')?.status,resumed:resumed.status,actionStatus:after?.status,nodeStatus:node?.status,amount}));
 expect(freshAction?.status).toBe('confirmed');expect(freshPlan?.status).toBe('running');expect(resumed.status).toBe('success');expect(after?.status).toBe('executed');expect(node?.status).toBe('success');expect(amount).toBe(500);
});

it('a committed side effect whose result transaction rolled back settles the node terminally as failed',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const seeded=await runSubmitPlan(userId,{goal:'结果事务回滚楔子',nodes:[{id:'card',name:'虚拟卡',kind:'tool',tool:'apply_virtual_card',args:{label:'回滚楔子探针'},dependencies:[]}]},{sessionId:s,runTool:runner(s)});
 const plan:any=seeded.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const spy=vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result transaction write injection'));
 const first=await confirmRaw(action.id,s);const faultCalls=spy.mock.calls.length;spy.mockRestore();
 const afterFault=await p.pendingAction.findUnique({where:{id:action.id}});const cardsAfterFault=await p.card.count({where:{userId,type:'VIRTUAL'}});
 expect(faultCalls).toBeGreaterThanOrEqual(1);expect(afterFault?.status).toBe('confirmed');expect(afterFault?.resultJson).toBeNull();expect(cardsAfterFault).toBe(1);
 const resumed=await task(plan.id,'resume',s);const resumedAgain=await task(plan.id,'resume',s);
 const node=await p.agentTaskNode.findFirst({where:{taskId:plan.id,nodeId:'card'}});const cards=await p.card.count({where:{userId,type:'VIRTUAL'}});
 console.log('REVIEW_RESULT_RECOVERY_TX_ROLLBACK_WEDGE',JSON.stringify({firstHttp:first.status,faultCalls,afterFault:afterFault?.status,resultAfterFault:afterFault?.resultJson,cardsAfterFault,resumed:resumed.status,resumedAgain:resumedAgain.status,nodeStatus:node?.status,nodeError:node?.error,cards}));
 expect(resumed.status).not.toBe('waiting_confirmation');expect(resumed.status).toBe('failed');expect(resumedAgain.status).not.toBe('waiting_confirmation');expect(node?.status).toBe('failed');expect(node?.error).toContain('人工核对');expect(cards).toBe(1);
});
