/** 真实模型 + 银行 HTTP + Chrome；微信端使用本地协议服务器，不冒充手机实测。 */
import nextEnv from '@next/env';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getUpdates, sendMessage } from 'pi-weixinbot/src/weixin-api.ts';
import type { WeixinMessage } from 'pi-weixinbot/src/types.ts';
import { BankingHttpClient } from '../../channels/weixin/banking-client';
import { WeixinBridge } from '../../channels/weixin/bridge';
import { emptyState } from '../../channels/weixin/state';
import { createDatabaseClient } from '../../lib/db/database';
import { bootDevServer, launchBrowser, resolveBrowserExecutable, gotoAgent, captureScreenshot, type DevServer } from './helpers';
import type { Browser } from 'playwright-core';

nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() { throw new Error('Cannot load live environment'); } });
process.env.LLM_MODE = 'live';
const runId = randomUUID();
const databaseFile = path.resolve('prisma', `weixin-live-${runId}.db`);
if (existsSync(databaseFile)) throw new Error('Refusing to reuse an existing database');
process.env.DATABASE_URL = `file:${databaseFile.replaceAll('\\', '/')}`;
process.env.DEMO_USER_ID = 'user_liming';
mkdirSync('logs', { recursive: true });
const report: Record<string, unknown> = { llmMode: 'live', weixinTransport: 'local protocol server, not an authenticated phone', cases: [] };
const cases: Array<{ name: string; status: string }> = [];
const persist = () => {
  report.cases = cases;
  const json = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  writeFileSync('logs/weixin-live-acceptance.json', json);
  writeFileSync(`logs/weixin-live-acceptance-${runId}.json`, json);
};
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
function cli(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Isolated DB setup failed (${result.status}): ${result.stderr}`);
}
const db = createDatabaseClient(process.env.DATABASE_URL);
let server: DevServer | undefined;
let browser: Browser | undefined;
let incoming: WeixinMessage[] = [];
const outgoing: Array<{ to_user_id: string; client_id: string; item_list: Array<{ text_item: { text: string } }> }> = [];
const protocol = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  if (request.url?.endsWith('/getupdates')) {
    const msgs = incoming; incoming = [];
    response.end(JSON.stringify({ ret: 0, msgs, get_updates_buf: 'next' }));
  } else {
    outgoing.push(JSON.parse(raw).msg); response.end('{"ret":0}');
  }
});

try {
  cli(['node_modules/prisma/build/index.js', 'db', 'push']);
  cli(['--import', 'tsx', 'prisma/seed.ts']);
  report.databaseFile = databaseFile;
  server = await bootDevServer();
  const bank = new BankingHttpClient(server.baseUrl);
  const health = await bank.health(); assert(health.llmMode === 'live', 'Server is not live'); report.health = health;
  await new Promise<void>(resolve => protocol.listen(0, '127.0.0.1', resolve));
  const address = protocol.address(); assert(address && typeof address !== 'string', 'No protocol port');
  const wireUrl = `http://127.0.0.1:${address.port}`;
  const state = emptyState(); state.auth = { botId: 'test-bot', ownerId: 'test-owner', token: 'not-a-real-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const replies: string[] = [];
  const bridge = new WeixinBridge(state, bank, { async send(to, text, clientId, contextToken) {
    await sendMessage({ baseUrl: wireUrl, token: 'not-a-real-token', to, text, clientId, contextToken }); replies.push(text);
  } }, async () => undefined);
  let counter = 0;
  async function receive(text: string, from = 'test-owner', reuse?: number) {
    const message: WeixinMessage = { message_id: reuse ?? ++counter, from_user_id: from, to_user_id: 'test-bot',
      message_type: 1, message_state: 2, context_token: 'test-context', item_list: [{ type: 1, text_item: { text } }] };
    incoming.push(message);
    const batch = await getUpdates({ baseUrl: wireUrl, token: 'not-a-real-token' });
    for (const entry of batch.msgs || []) await bridge.handle(entry);
    return message.message_id as number;
  }
  async function check(name: string, fn: () => Promise<void>) {
    await fn(); cases.push({ name, status: 'PASS' }); console.log('PASS', name); persist();
  }
  const initial = await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
  await check('陌生人不进入真实模型，也不收到银行回复', async () => {
    await receive('查询余额', 'stranger'); assert(outgoing.length === 0, 'Stranger got a response');
    assert(await db.modelRequest.count() === 0, 'Stranger reached model');
  });
  await check('微信协议消息→真实模型→查询结果回复', async () => {
    await receive('查询我的活期账户余额，直接显示当前余额。');
    assert(replies.some(text => /23,?580(?:\.00)?/.test(text)), 'Checking balance missing from IM reply');
  });
  let transferId = '';
  let transferMessageId = 0;
  await check('小额转账生成真实待确认操作，确认前余额不变', async () => {
    transferMessageId = await receive('请从活期账户转账200.37元给联系人张伟，备注微信通道验收。');
    const action = await db.pendingAction.findFirst({ where: { toolName: 'transfer_money' }, orderBy: { createdAt: 'desc' } });
    assert(action && ['pending', 'awaiting_mfa'].includes(action.status), 'No real pending transfer'); transferId = action.id;
    assert((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor === initial.balanceMinor, 'Transfer executed without confirmation');
    assert(replies.at(-1)?.includes(`/确认 ${transferId}`), 'IM omitted actual confirmation command');
    const executable = resolveBrowserExecutable(); assert(executable, 'Chrome not found'); browser = await launchBrowser(executable);
    const page = await browser.newPage(); await gotoAgent(page, server!.baseUrl);
    await page.locator('[data-approval-request="true"]').waitFor({ state: 'visible' });
    await captureScreenshot(page, 'weixin-live-pending-transfer'); await page.close();
  });
  await check('IM 显式确认执行且重复消息不重复扣款', async () => {
    const id = await receive(`/确认 ${transferId}`);
    assert((await db.pendingAction.findUniqueOrThrow({ where: { id: transferId } })).status === 'executed', 'Transfer not executed');
    assert((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor === initial.balanceMinor - 20037n, 'Wrong transfer debit');
    const before = await db.transaction.count(); await receive(`/确认 ${transferId}`, 'test-owner', id);
    await receive('请从活期账户转账200.37元给联系人张伟，备注微信通道验收。', 'test-owner', transferMessageId);
    assert(await db.transaction.count() === before, 'Duplicate delivery wrote a second ledger row');
  });
  await check('红色操作保留确认/错码拒绝/正确码执行', async () => {
    await receive('尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。');
    const action = await db.pendingAction.findFirst({ where: { toolName: 'report_lost_card' }, orderBy: { createdAt: 'desc' } });
    assert(action && action.requiresMfa, 'RED action did not require verification');
    await receive(`/确认 ${action.id}`);
    await receive(`/验证 ${action.id} 000000`);
    assert((await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status === 'ACTIVE', 'Wrong code changed card');
    await receive(`/验证 ${action.id} 123456`);
    assert((await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status === 'LOST', 'Correct code did not execute');
  });
  await check('取消和网页持久化状态一致', async () => {
    await receive('请再转账50.18元给联系人李华，备注这笔稍后取消。');
    const action = await db.pendingAction.findFirst({ where: { toolName: 'transfer_money', status: { in: ['pending', 'awaiting_mfa'] } }, orderBy: { createdAt: 'desc' } });
    assert(action, 'No pending action to cancel');
    const balance = (await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    await receive(`/取消 ${action.id}`);
    assert((await db.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status === 'cancelled', 'Cancellation not persisted');
    assert((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor === balance, 'Cancel moved money');
    const page = await browser!.newPage(); await gotoAgent(page, server!.baseUrl);
    assert(await page.locator('[data-approval-request="true"]').count() === 0, 'Web still offers settled actions');
    await captureScreenshot(page, 'weixin-live-completed'); await page.close();
  });
  const requests = await db.modelRequest.findMany({ select: { id: true, status: true } });
  const events = await db.agentRunEvent.findMany({ where: { eventType: 'provider_response_headers' }, select: { payloadJson: true } });
  report.modelEvidence = { requests, actualHttp200: events.map(e => JSON.parse(e.payloadJson)).filter(e => e.payload?.status === 200).length };
  assert((report.modelEvidence as {actualHttp200:number}).actualHttp200 > 0, 'Missing actual provider response evidence');
  report.outgoingCount = outgoing.length; report.onlyBoundPeer = outgoing.every(m => m.to_user_id === 'test-owner');
  report.cases = cases; console.log(`PASS ${cases.length} / FAIL 0 (live LLM; local Weixin protocol server)`);
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error); console.error('FAIL', report.failure); process.exitCode = 1;
} finally {
  persist(); if (browser) await browser.close(); if (server) server.stop();
  if (protocol.listening) await new Promise<void>(resolve => protocol.close(() => resolve()));
  await db.$disconnect();
}
