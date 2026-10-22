import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { toJson } from '@/lib/json';
import { NextRequest } from 'next/server';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
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
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
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

it('a card limit node cannot create another action during the action-to-node persistence window',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const result=await runSubmitPlan(userId,{goal:'Set the entertainment limit',nodes:[node('set_card_limit',{cardId:'card_credit',category:'\u5a31\u4e50',amount:'1500'})]},{sessionId:s,runTool:runner(s)});
 const plan:any=result.data;const action=(await p.pendingAction.findFirst({where:{sessionId:s}}))!;
 const original=gateway.recordActionResult.bind(gateway),reached=deferred(),release=deferred();
 vi.spyOn(gateway,'recordActionResult').mockImplementation(async(...args:any[])=>{await (original as any)(...args);if(args[0]===action.id){reached.release();await release.promise;}});
 const confirming=confirm(action.id,s);let second:any;
 try{await bounded(reached.promise);await task(plan.id,'resume',s);second=await p.pendingAction.findFirst({where:{sessionId:s,id:{not:action.id}}});}
 finally{release.release();await confirming;}
 if(second)await confirm(second.id,s);
 const limits=await p.cardLimit.findMany({where:{cardId:'card_credit',category:'\u5a31\u4e50'}});
 expect(second).toBeNull();expect(limits).toHaveLength(1);expect(limits[0].amountMinor).toBe(150000n);
 expect(await p.executionReceipt.count({where:{userId,key:`nxe:${plan.id}:n`}})).toBe(1);
});

it('a distinct redemption action cannot report another credit for an already redeemed holding',async()=>{
 const s=(await getDemoSession(userId)).sessionId;const p=getTestPrisma();
 const call=()=>executeGatedTool({sessionId:s,userId,toolName:'redeem_investment',args:{holdingId:'holding_wenjiana',mode:'ALL'},userRequest:'赎回理财'});
 /** Investment-flow CREDIT rows on the funding account: one redemption books exactly one. */
 const redemptionCredits=()=>p.transaction.count({where:{userId,accountId:'acct_checking',category:'\u6295\u8d44',direction:'CREDIT'}});
 const creditsBefore=await redemptionCredits();
 const a=await call();const first=await confirm(a.pendingActionId!,s,'123456');const firstBalance=(await p.account.findFirst({where:{userId,type:'CHECKING'}}))!.balanceMinor;
 const firstCredits=await redemptionCredits();
 const b=await call();const secondBalance=(await p.account.findFirst({where:{userId,type:'CHECKING'}}))!.balanceMinor;
 const holding=await p.investmentHolding.findUnique({where:{id:'holding_wenjiana'}});
 const actions=await p.pendingAction.findMany({where:{sessionId:s},select:{id:true,status:true}});
 console.log('REVIEW_REDEEM_IDENTITY',toJson({firstAction:a.pendingActionId,second:b,firstOk:first.ok,firstBalance,secondBalance,creditsBefore,firstCredits,shares:holding?.shares,status:holding?.status,actions}));
 expect(first.ok).toBe(true);expect(firstBalance).toBe(2863000n);expect(firstCredits).toBe(creditsBefore+1);
 // The second request is refused while PARKING the quote: the redeemed position records no shares,
 // so it never mints a second actionable PendingAction and never even reaches an approval step.
 expect(b.ok).toBe(false);expect(b.errorCode).toBe('CONFLICT');
 expect(b.error).toContain('该持仓尚未记录份额，暂不可赎回');
 expect(b.pendingActionId).toBeUndefined();
 // Zero writes: no second credit, no balance move, one closed position, one action row in total.
 expect(secondBalance).toBe(firstBalance);expect(await redemptionCredits()).toBe(firstCredits);
 expect(holding?.shares).toBe('0');expect(holding?.status).toBe('REDEEMED');
 expect(actions).toHaveLength(1);expect(actions[0].id).toBe(a.pendingActionId);expect(actions[0].status).toBe('executed');
});
