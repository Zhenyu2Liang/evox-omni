import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { toJson } from '@/lib/json';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { securityGateway as gateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
const userId='user_liming';
beforeEach(()=>resetDatabase());afterEach(()=>vi.restoreAllMocks());afterAll(()=>disconnectTestPrisma());
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
async function bounded(p:Promise<unknown>){let timer:any;try{await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('review barrier timeout')),7000))]);}finally{clearTimeout(timer);}}
const runner=(s:string)=>(toolName:string,args:Record<string,unknown>,ctx?:{taskId?:string;nodeId?:string})=>executeGatedTool({sessionId:s,userId,toolName:toolName as any,args,userRequest:'审查',taskId:ctx?.taskId,nodeId:ctx?.nodeId});
const node=(tool:string,args:any)=>({id:'n',name:'审查节点',kind:'tool' as const,tool,args,dependencies:[]});
async function task(id:string,action:string,s:string){const res=await taskPost(new NextRequest(`http://localhost/api/tasks/${id}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify({action})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}
async function confirm(id:string,s:string,code?:string){const res=await (code?verifyPost:confirmPost)(new NextRequest(`http://localhost/api/actions/${id}/${code?'verify':'confirm'}`,{method:'POST',headers:{'Content-Type':'application/json',cookie:`banking_session=${s}`},body:JSON.stringify(code?{code}:{})}),{params:Promise.resolve({id})});const body=await res.json();expect(res.status).toBe(200);return body.data;}

it('cancel preserves the executed truth when a transfer is ledgered before result persistence',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'转账后取消',nodes:[node('transfer_money',{name:'张伟',amount:'200'})]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const original=gateway.recordActionResult.bind(gateway),reached=deferred(),release=deferred();
 vi.spyOn(gateway,'recordActionResult').mockImplementation(async(...args:any[])=>{if(args[0]===action.id){reached.release();await release.promise;}return (original as any)(...args);});
 const confirming=confirm(action.id,s);let cancelled:any,response:any;
 try{await bounded(reached.promise);cancelled=await task(plan.id,'cancel',s);}finally{release.release();response=await confirming;}
 const stored=await p.pendingAction.findUnique({where:{id:action.id}});const account=await p.account.findFirst({where:{userId,type:'CHECKING'}});
 const debits=await p.transaction.findMany({where:{userId,channel:'TRANSFER',direction:'DEBIT',amountMinor:-20000n}});
 console.log('REVIEW_EXECUTED_TRUTH',toJson({planStatus:cancelled.status,responseStatus:response.status,storedStatus:stored?.status,balance:account?.balanceMinor,debits:debits.map(x=>x.amountMinor)}));
 expect(account?.balanceMinor).toBe(2338000n);expect(debits.length).toBe(1);expect(response.status).toBe('executed');expect(stored?.status).toBe('executed');
});

it('a virtual card node cannot create another card during the action-to-node persistence window',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'申请一张虚拟卡',nodes:[node('apply_virtual_card',{label:'审查虚拟卡'})]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const original=gateway.recordActionResult.bind(gateway),reached=deferred(),release=deferred();
 vi.spyOn(gateway,'recordActionResult').mockImplementation(async(...args:any[])=>{await (original as any)(...args);if(args[0]===action.id){reached.release();await release.promise;}});
 const confirming=confirm(action.id,s);let second:any;
 try{await bounded(reached.promise);await task(plan.id,'resume',s);second=await p.pendingAction.findFirst({where:{sessionId:s,id:{not:action.id}}});}
 finally{release.release();await confirming;}
 if(second)await confirm(second.id,s);
 const cards=await p.card.findMany({where:{userId,type:'VIRTUAL'}});
 console.log('REVIEW_VIRTUAL_CARD_REPLAY',JSON.stringify({secondAction:second?.id,cards:cards.map(x=>x.id)}));
 expect(cards.length).toBe(1);
});

it('a distinct redemption action cannot report another credit for an already redeemed holding',async()=>{
 const s=(await getOrCreateSession(userId)).sessionId;const p=getTestPrisma();
 const call=()=>executeGatedTool({sessionId:s,userId,toolName:'redeem_investment',args:{holdingId:'holding_wenjiana'},userRequest:'赎回理财'});
 const a=await call();const first=await confirm(a.pendingActionId!,s,'123456');const firstBalance=(await p.account.findFirst({where:{userId,type:'CHECKING'}}))!.balanceMinor;
 const b=await call();const second=await confirm(b.pendingActionId!,s,'123456');const secondBalance=(await p.account.findFirst({where:{userId,type:'CHECKING'}}))!.balanceMinor;
 console.log('REVIEW_REDEEM_IDENTITY',toJson({firstAction:a.pendingActionId,secondAction:b.pendingActionId,firstOk:first.ok,secondOk:second.ok,secondStatus:second.status,secondResult:second.result,firstBalance,secondBalance}));
 expect(first.ok).toBe(true);expect(firstBalance).toBe(2863000n);expect(secondBalance).toBe(firstBalance);expect(second.ok).toBe(false);
});
