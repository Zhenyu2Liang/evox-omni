
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toJson } from '@/lib/json';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, verifyAction, loadSession, getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { requestedSteps } from '@/lib/request-steps';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';
beforeEach(resetDatabase); afterAll(disconnectTestPrisma);
const config={llmMode:'live' as const,llmProvider:'deepseek',llmModel:'deepseek-flash',demoUserId:'user_liming'};
describe('110e20a independent boundary review',()=>{
 it('keeps the second transfer when a negative remark modifier is attached to the first',async()=>{
  const faux=fauxProvider(),models=createModels();models.setProvider(faux.provider);
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('transfer_money',{name:'张伟',amount:'100.17'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxToolCall('transfer_money',{name:'王芳',amount:'200.29'})],{stopReason:'toolUse'})
  ]);
  let calls=0;const provider={model:faux.getModel(),streamFn:(...args:Parameters<typeof models.streamSimple>)=>{calls++;return models.streamSimple(...args)}};
  await runTurn({message:'先给张伟转100.17元不要填写备注，再给王芳转200.29元。'},{config,provider});
  const first=await getTestPrisma().pendingAction.findFirst();
  if(first)await confirmAction(first.id,{deps:{config,provider}});
  const plans=await getTestPrisma().agentTask.count();
  const actions=await getTestPrisma().pendingAction.findMany({select:{status:true,argsJson:true}});
  const balance=(await getTestPrisma().account.findUniqueOrThrow({where:{id:'acct_checking'}})).balanceMinor;
  console.log('NEGATED_REMARK_REVIEW',toJson({calls,plans,actions,balance}));
  expect(plans>0||actions.length===0).toBe(true);
 });
 it('accepts a complete redemption/transfer plan using the owned holding identity',async()=>{
  const session=await getOrCreateSession('user_liming');
  const request='先赎回稳健理财A全部持仓，再给张伟转账100.17元';
  const result=await runSubmitPlan('user_liming',{goal:request,nodes:[
   {id:'redeem',name:'全额赎回稳健理财A',kind:'tool',tool:'redeem_investment',args:{holdingId:'holding_wenjiana'},dependencies:[]},
   {id:'transfer',name:'转账',kind:'tool',tool:'transfer_money',args:{name:'张伟',amount:'100.17'},dependencies:['redeem']}
  ]},{sessionId:session.sessionId,userRequest:()=>request,runTool:(toolName,args,ctx)=>executeGatedTool({sessionId:session.sessionId,userId:'user_liming',toolName,args,userRequest:request,...ctx})});
  console.log('REDEEM_PLAN_REVIEW',JSON.stringify({ok:result.ok,error:result.error,plans:await getTestPrisma().agentTask.count(),actions:await getTestPrisma().pendingAction.count()}));
  expect(result.ok).toBe(true);
 });
});

const node = (id: string, tool: string, args: Record<string, unknown>, dependencies: string[] = []): TaskNodeSpec =>
 ({ id, name: id, kind: 'tool', tool, args, dependencies });
const call = (tool: string, args: Record<string, unknown>) =>
 fauxAssistantMessage([fauxToolCall(tool, args as JsonObject)], { stopReason: 'toolUse' });
function scripted(responses: ReturnType<typeof fauxAssistantMessage>[]) {
 const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
 let count = 0;
 return { model: faux.getModel(), streamFn: (...args: Parameters<typeof models.streamSimple>) => {
  count++; return models.streamSimple(...args);
 }, calls: () => count };
}
async function submit(nodes: TaskNodeSpec[], request: string) {
 const session = await getOrCreateSession('user_liming');
 return runSubmitPlan('user_liming', { goal: request, nodes }, { sessionId: session.sessionId, userRequest: () => request,
  runTool: (toolName, args, ctx) => executeGatedTool({ sessionId: session.sessionId, userId: 'user_liming', toolName, args, userRequest: request, ...ctx }) });
}
const transferNodes = () => [node('first', 'transfer_money', { name: '张伟', amount: '100.17' }),
 node('second', 'transfer_money', { name: '王芳', amount: '200.29' }, ['first'])];
async function noEntry() {
 expect(await getTestPrisma().pendingAction.count()).toBe(0);
 expect(await getTestPrisma().agentTask.count()).toBe(0);
 expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('request scope and owned redemption [integration]', () => {
 it.each(['不要填写备注', '但不要重复扣款', '不必填写备注', '不用添加备注'])('keeps a positive first step with the qualifier %s', async qualifier => {
  const runtime = scripted([call('transfer_money', { name: '张伟', amount: '100.17' }), call('transfer_money', { name: '王芳', amount: '200.29' })]);
  await runTurn({ message: `先给张伟转100.17元${qualifier}，再给王芳转200.29元` }, { config, provider: runtime });
  expect(runtime.calls()).toBe(2);
  await noEntry();
 });
 it('repairs a qualifier-bearing request into a full plan and confirms both legs without another model call', async () => {
  const runtime = scripted([call('transfer_money', { name: '张伟', amount: '100.17' }), call('submit_plan', { goal: 'two steps', nodes: transferNodes() })]);
  const result = await runTurn({ message: '先给张伟转100.17元不要填写备注，再给王芳转200.29元' }, { config, provider: runtime });
  expect(await getTestPrisma().agentTaskNode.count()).toBe(2);
  const first = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'first' } });
  expect((await confirmAction(first.id, { deps: { config, provider: runtime } })).ok).toBe(true);
  const second = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'second' } });
  expect((await confirmAction(second.id, { deps: { config, provider: runtime } })).ok).toBe(true);
  expect(runtime.calls()).toBe(2);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
  expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toContain('23,279.54');
  expect(await getTestPrisma().transaction.count({ where: { amountMinor: { in: [-10017n, -20029n] }, channel: 'TRANSFER' } })).toBe(2);
 });
 it('keeps an explicitly negated transfer out of the required plan steps', async () => {
  expect(requestedSteps('给张伟不要转100.17元，再给王芳转200.29元')).toHaveLength(1);
  expect(requestedSteps('不要给张伟转100.17元，但给王芳转200.29元')).toHaveLength(1);
  const result = await submit(transferNodes(), '不要给李华转50元，先给张伟转100.17元，再给王芳转200.29元');
  expect(result.ok).toBe(true);
  expect(await getTestPrisma().agentTaskNode.count()).toBe(2);
  expect(JSON.parse((await getTestPrisma().pendingAction.findFirstOrThrow()).argsJson).contactId).toBe('contact_zhangwei');
 });
 it('binds the canonical holding, requires MFA, credits once, then offers the saved transfer', async () => {
  const nodes = [node('redeem', 'redeem_investment', { holdingId: 'holding_wenjiana' }),
   node('transfer', 'transfer_money', { name: '张伟', amount: '100.17' }, ['redeem'])];
  const runtime = scripted([call('submit_plan', { goal: 'redemption then transfer', nodes })]);
  await runTurn({ message: '先赎回稳健理财A全部持仓，再给张伟转账100.17元' }, { config, provider: runtime });
  const first = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'redeem' } });
  expect(first.status).toBe('awaiting_mfa');
  expect(JSON.parse(first.argsJson)).toMatchObject({ holdingId: 'holding_wenjiana', expectedRedemptionAmount: '5050.00' });
  await verifyAction(first.id, '000000', { deps: { config, provider: runtime } });
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  expect(await getTestPrisma().pendingAction.count()).toBe(1);
  expect((await verifyAction(first.id, '123456', { deps: { config, provider: runtime } })).ok).toBe(true);
  const second = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'transfer' } });
  expect((await confirmAction(second.id, { deps: { config, provider: runtime } })).ok).toBe(true);
  await verifyAction(first.id, '123456', { deps: { config, provider: runtime } });
  expect(runtime.calls()).toBe(1);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2852983n);
  expect(await getTestPrisma().transaction.count({ where: { category: '投资', direction: 'CREDIT' } })).toBe(1);
  expect(await getTestPrisma().transaction.count({ where: { amountMinor: -10017n, channel: 'TRANSFER' } })).toBe(1);
 });
 it.each(['稳健理财A', 'WJA001'])('normalizes the unique owned selector %s into the saved node ID', async holdingId => {
  const result = await submit([node('redeem', 'redeem_investment', { holdingId }), transferNodes()[0]],
   '先赎回稳健理财A全部持仓，再给张伟转100.17元');
  expect(result.ok).toBe(true);
  expect(JSON.parse((await getTestPrisma().pendingAction.findFirstOrThrow()).argsJson).holdingId).toBe('holding_wenjiana');
 });
 it.each(['foreign', 'ambiguous', 'inactive', 'wrong-product'])('rejects %s holdings before an earlier automatic budget write', async scenario => {
  const db = getTestPrisma();
  let holdingId = 'holding_wenjiana';
  if (scenario === 'foreign') {
   await db.user.create({ data: { id: 'scope_other', name: 'Other', phone: '13800009091' } });
   await db.investmentHolding.create({ data: { id: 'foreign_holding', userId: 'scope_other', productId: 'prod_wenjiana', principalAmountMinor: 100000n } });
   holdingId = 'foreign_holding';
  } else if (scenario === 'ambiguous') {
   await db.investmentHolding.create({ data: { id: 'second_holding', userId: 'user_liming', productId: 'prod_wenjiana', principalAmountMinor: 100000n } });
   holdingId = '稳健理财A';
  } else if (scenario === 'inactive') {
   await db.investmentHolding.update({ where: { id: holdingId }, data: { status: 'REDEEMED' } });
  } else {
   await db.investmentHolding.create({ data: { id: 'other_product_holding', userId: 'user_liming', productId: 'prod_huobi', principalAmountMinor: 100000n } });
   holdingId = 'other_product_holding';
  }
  const request = scenario === 'inactive' ? `先预留2.22元预算，再赎回${holdingId}全部持仓` : '先预留2.22元预算，再赎回稳健理财A全部持仓';
  const result = await submit([node('budget', 'reserve_budget', { name: 'must-not-land', amount: '2.22' }),
   node('redeem', 'redeem_investment', { holdingId, productId: 'prod_wenjiana' }, ['budget'])], request);
  expect(result.ok).toBe(false);
  expect(await db.budget.count({ where: { name: 'must-not-land' } })).toBe(0);
  await noEntry();
 });
 it('keeps same-product holdings distinct by their actual IDs and orders shuffled nodes correctly', async () => {
  await getTestPrisma().investmentHolding.create({ data: { id: 'another_holding', userId: 'user_liming', productId: 'prod_wenjiana', principalAmountMinor: 100000n } });
  const result = await submit([node('second', 'redeem_investment', { holdingId: 'another_holding' }),
   node('first', 'redeem_investment', { holdingId: 'holding_wenjiana' })], '先赎回holding_wenjiana全部持仓，再赎回another_holding全部持仓');
  expect(result.ok).toBe(true);
  const action = await getTestPrisma().pendingAction.findFirstOrThrow();
  expect(action.nodeId).toBe('first');
  expect(JSON.parse(action.argsJson).holdingId).toBe('holding_wenjiana');
 });
});
