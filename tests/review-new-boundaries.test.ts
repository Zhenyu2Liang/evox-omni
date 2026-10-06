import { beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool, confirmAction, verifyAction } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { security } from '@/security';
import { securityGateway as gateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase()); afterEach(()=>vi.restoreAllMocks()); afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try {await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
const node=(tool:string,args:any)=>({id:'n',name:'审查节点',kind:'tool' as const,tool,args,dependencies:[]});
async function post(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});return {http:res.status,...await res.json()};}
async function confirm(id:string,s:string,code?:string){const path=code?'verify':'confirm';const res=await (code?verifyPost:confirmPost)(new NextRequest(`http://localhost/api/actions/${id}/${path}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify(code?{code}:{})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}

it('a plan transfer already ledgered but still confirmed is counted once',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 await runSubmitPlan(userId,{goal:'转600',nodes:[node('transfer_money',{name:'张伟',amount:600})]},{sessionId:s,runTool:runner(s)});
 const action=(await getTestPrisma().pendingAction.findFirst({where:{sessionId:s}}))!;
 const original=gateway.recordActionResult.bind(gateway);const reached=deferred(),release=deferred();
 vi.spyOn(gateway,'recordActionResult').mockImplementation(async(...args:any[])=>{if(args[0]===action.id){reached.release();await release.promise;}return (original as any)(...args);});
 const first=confirm(action.id,s);let later:any,total:any;
 try{await bounded(reached.promise);total=await security.risk.computeDailyTransferTotal(userId);later=await executeGatedTool({sessionId:s,userId,toolName:'transfer_money',args:{name:'张伟',amount:100},userRequest:'转100'});if(later.pendingActionId)later=await confirm(later.pendingActionId,s);}
 finally{release.release();await first;}
 console.log('REVIEW_PLAN_LEDGER',JSON.stringify({alreadyLedgered:total,laterTier:later.tier,laterRequiresMfa:later.requiresMfa,laterStatus:later.status}));
 expect(later.requiresMfa).toBe(false);
});

it('resuming an investment node during post-effect persistence cannot debit twice',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;
 const result=await runSubmitPlan(userId,{goal:'买理财',nodes:[node('subscribe_investment',{productId:'prod_wenjiana',amount:1000})]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const firstAction=(await getTestPrisma().pendingAction.findFirst({where:{sessionId:s}}))!;
 const original=gateway.recordActionResult.bind(gateway);const reached=deferred(),release=deferred();
 vi.spyOn(gateway,'recordActionResult').mockImplementation(async(...args:any[])=>{if(args[0]===firstAction.id){reached.release();await release.promise;}return (original as any)(...args);});
 const first=confirm(firstAction.id,s,'123456');let second:any;let resumed:any;
 try{await bounded(reached.promise);resumed=await post(plan.id,'resume',s);second=await getTestPrisma().pendingAction.findFirst({where:{sessionId:s,id:{not:firstAction.id}}});}
 finally{release.release();await first;}
 if(second)await confirm(second.id,s,'123456');
 const balance=await getTestPrisma().account.findFirst({where:{userId,type:'CHECKING'}});const purchases=await getTestPrisma().investmentHolding.count({where:{userId,amount:1000}});
 console.log('REVIEW_INVESTMENT_REPLAY',JSON.stringify({secondAction:second?.id,resumeStatus:resumed.data?.status,balance:balance?.balance,purchases}));
 expect(balance?.balance).toBe(22580);expect(purchases).toBe(1);
});

it('a plan cancellation completed before authorization CAS prevents the debit',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const beforeTool=deferred(),allowTool=deferred(),afterTool=deferred(),finishTool=deferred();let actionId='';
 const running=runSubmitPlan(userId,{goal:'转账取消竞争',nodes:[node('transfer_money',{name:'张伟',amount:200})]},{sessionId:s,runTool:async(tool,args,ctx)=>{beforeTool.release();await allowTool.promise;const result=await runner(s)(tool,args,ctx);actionId=result.pendingActionId!;afterTool.release();await finishTool.promise;return result;}});
 const afterBulk=deferred(),allowCancel=deferred(),beforeAuthorize=deferred(),allowAuthorize=deferred();
 let cancelling:Promise<any>|undefined,confirming:Promise<any>|undefined,cancelled:any;
 try{
  await bounded(beforeTool.promise);const task=(await p.agentTask.findFirst({where:{sessionId:s}}))!;
  const origBulk=p.pendingAction.updateMany.bind(p.pendingAction);
  vi.spyOn(p.pendingAction,'updateMany').mockImplementation(((async(args:any)=>{const result=await origBulk(args);if(args.where.taskId===task.id){afterBulk.release();await allowCancel.promise;}return result;}) as any));
  cancelling=post(task.id,'cancel',s);await bounded(afterBulk.promise);
  allowTool.release();await bounded(afterTool.promise);
  const origAuth=gateway.authorizeAction.bind(gateway);
  vi.spyOn(gateway,'authorizeAction').mockImplementation(async(...args:any[])=>{beforeAuthorize.release();await allowAuthorize.promise;return (origAuth as any)(...args);});
  confirming=confirm(actionId,s);await bounded(beforeAuthorize.promise);
  allowCancel.release();cancelled=await cancelling;
  allowAuthorize.release();await confirming;
 }finally{allowTool.release();finishTool.release();allowCancel.release();allowAuthorize.release();await Promise.allSettled([running,...(cancelling?[cancelling]:[]),...(confirming?[confirming]:[])])}
 const total=await security.risk.computeDailyTransferTotal(userId);const action=await p.pendingAction.findUnique({where:{id:actionId}});
 console.log('REVIEW_CANCEL_GAP',JSON.stringify({cancelled:cancelled?.data?.status,actionStatus:action?.status,total}));
 expect(cancelled.data.status).toBe('cancelled');expect(total).toBe(0);
});
