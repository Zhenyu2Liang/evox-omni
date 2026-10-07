/** Browser handoff journey. Only the initial stopped-query failure is a seeded test fixture. */
import { PrismaClient } from '@prisma/client';
import type { Browser } from 'playwright-core';
import { gotoAgent, NAV_TIMEOUT_MS, readSessionCookie, submitChat, waitFor, withPage } from './helpers';

export async function journeyManualReview(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async (page) => {
    await gotoAgent(page, baseUrl);
    await submitChat(page, '查一下我的余额');
    const cookie = await waitFor(async () => await readSessionCookie(page) || false,
      { description: '人工处理会话 cookie', timeoutMs: NAV_TIMEOUT_MS });
    const sessionId = cookie.slice(cookie.indexOf('=') + 1);
    const p = new PrismaClient();
    try {
      const task = await p.agentTask.create({ data: { sessionId, userId: 'user_liming',
        goal: '人工核对查询失败后调整限额', status: 'failed', nodes: { create: [
          { nodeId: 'before', name: '已完成的查询', kind: 'note', status: 'success', order: 0, dependencies: '[]', output: '{"checked":true}' },
          { nodeId: 'read', name: '暂时失败的查询', kind: 'tool', tool: 'get_balance', args: '{}', status: 'failed', error: '查询服务暂不可用', order: 1, dependencies: '["before"]' },
          { nodeId: 'limit', name: '调整娱乐限额', kind: 'tool', tool: 'set_card_limit', args: '{"cardId":"card_credit","category":"娱乐","amount":1400}', status: 'skipped', order: 2, dependencies: '["read"]' },
        ] } } });
      const before = await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
      await page.goto(`${baseUrl}/manual`, { waitUntil: 'domcontentloaded' });
      const reason = page.getByRole('textbox', { name: '转人工原因：人工核对查询失败后调整限额', exact: true });
      await reason.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await reason.fill('查询暂时失败，请人工核对后继续');
      await page.getByRole('button', { name: '转人工处理', exact: true }).click();
      await page.getByText('人工处理中', { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('人工处理中', { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const held = await page.request.post(`${baseUrl}/api/tasks/${task.id}`, { data: { action: 'retry' } });
      if (held.status() !== 409) throw new Error(`人工处理期间重试应被拒绝，实际 ${held.status()}`);
      await page.getByRole('textbox', { name: '核对说明：人工核对查询失败后调整限额', exact: true }).fill('已核对查询服务恢复，重新查询并等待用户确认限额');
      await page.getByRole('button', { name: '记录并继续任务', exact: true }).click();
      await page.getByText('任务已重新发起，请到 AI 助手确认操作或完成 MFA。', { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('已记录处理结论', { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const review = await p.manualReview.findFirstOrThrow({ where: { taskId: task.id } });
      const approval = await p.pendingAction.findFirstOrThrow({ where: { taskId: task.id } });
      const after = await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
      if (review.status !== 'closed' || review.resolution !== 'retry' || !review.notes || !review.operatorName.includes('李明')) throw new Error('处理人、说明或结论未持久化');
      if (approval.status !== 'pending' || after.amount !== before.amount) throw new Error('人工继续绕过了用户确认');
      if (await p.auditLog.count({ where: { dedupeKey: { startsWith: `manual:${review.id}:` } } }) !== 2) throw new Error('缺少转人工/处理结论审计');

      // A second fixture is unknown, not failed: the browser must offer stop/annotation only.
      const unknown = await p.pendingAction.create({ data: { sessionId, userId: 'user_liming', toolName: 'freeze_card',
        argsJson: '{"cardId":"card_credit"}', summaryJson: '{}', riskLevel: 'YELLOW', status: 'needs_reconciliation', userRequest: '结果不明的冻结操作' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('textbox', { name: '转人工原因：结果不明的冻结操作', exact: true }).fill('冻结结果不明，请登记人工核对');
      await page.getByRole('button', { name: '转人工处理', exact: true }).click();
      const notes = page.getByRole('textbox', { name: '核对说明：结果不明的冻结操作', exact: true });
      await notes.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      if (await page.getByRole('button', { name: '记录并继续任务', exact: true }).count()) throw new Error('未知结果不应提供继续入口');
      await notes.fill('执行证据不足，记录说明并结束自动处理，保留待核对状态');
      await page.getByRole('button', { name: '记录并结束自动处理', exact: true }).click();
      await page.getByText('已记录处理结论', { exact: true }).nth(1).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const current = await p.pendingAction.findUniqueOrThrow({ where: { id: unknown.id } });
      if (current.status !== 'needs_reconciliation' || current.resultJson !== null) throw new Error('人工说明改写了未知交易事实');
      return '失败任务→转人工→刷新保留→阻止直接重试→记录处理人/说明→继续后仍待用户确认；未知结果只登记/结束，保留待核对状态；两阶段审计齐全';
    } finally { await p.$disconnect(); }
  }, { label: 'g-manual-handoff' });
}
