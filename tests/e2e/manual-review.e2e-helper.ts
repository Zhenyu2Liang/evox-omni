/** Browser handoff journey. Only the initial stopped-query failure is a seeded test fixture. */
import { createDatabaseClient } from '../../lib/db/database';
import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { gotoAgent, NAV_TIMEOUT_MS, readDemoSessionId, submitChat, waitForElementHydration, withPage } from './helpers';

export async function journeyManualReview(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async (page) => {
    const t = createTranslator('zh-CN');
    await gotoAgent(page, baseUrl);
    await submitChat(page, '查一下我的余额');
    const sessionId = await readDemoSessionId(page);
    if (await page.locator('a[href="/manual"]:visible').count()) throw new Error('Normal navigation exposes the operator simulator');
    const denied = await page.request.get(`${baseUrl}/api/manual-reviews`);
    if (denied.status() !== 403) throw new Error('Normal mode can read the operator inbox');
    await waitForElementHydration(page, '[data-developer-toggle]');
    await page.locator('[data-developer-toggle]:visible').click();
    await page.locator('a[href="/manual"]:visible').waitFor();
    const p = createDatabaseClient();
    try {
      const task = await p.agentTask.create({ data: { sessionId, userId: 'user_liming',
        goal: '人工核对查询失败后调整限额', status: 'failed', nodes: { create: [
          { nodeId: 'before', name: '已完成的查询', kind: 'note', status: 'success', order: 0, dependencies: '[]', output: '{"checked":true}' },
          { nodeId: 'read', name: '暂时失败的查询', kind: 'tool', tool: 'get_balance', args: '{}', status: 'failed', error: '查询服务暂不可用', order: 1, dependencies: '["before"]' },
          { nodeId: 'limit', name: '调整娱乐限额', kind: 'tool', tool: 'set_card_limit', args: '{"cardId":"card_credit","category":"娱乐","amount":"1400.00"}', status: 'skipped', order: 2, dependencies: '["read"]' },
        ] } } });
      const before = await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
      await page.goto(`${baseUrl}/manual`, { waitUntil: 'domcontentloaded' });
      const reason = page.getByRole('textbox', { name: t('tasks.manual.formLabel', {
        label: t('tasks.manual.reasonLabel'), title: task.goal,
      }), exact: true });
      await reason.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await reason.fill('查询暂时失败，请人工核对后继续');
      await page.locator('section').filter({ has: reason }).getByRole('button', { name: t('tasks.manual.handoff'), exact: true }).click();
      await page.getByText(t('tasks.manual.open'), { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText(t('tasks.manual.open'), { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const held = await page.request.post(`${baseUrl}/api/tasks/${task.id}`, { data: { action: 'retry' } });
      if (held.status() !== 409) throw new Error(`人工处理期间重试应被拒绝，实际 ${held.status()}`);
      await page.getByRole('textbox', { name: t('tasks.manual.formLabel', {
        label: t('tasks.manual.notesLabel'), title: task.goal,
      }), exact: true }).fill('已核对查询服务恢复，重新查询并等待用户确认限额');
      await page.getByRole('button', { name: t('tasks.manual.saveAndRetry'), exact: true }).click();
      await page.getByText(t('tasks.manual.confirmationNeeded'), { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText(t('tasks.manual.resolved'), { exact: true }).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const review = await p.manualReview.findFirstOrThrow({ where: { taskId: task.id } });
      const approval = await p.pendingAction.findFirstOrThrow({ where: { taskId: task.id } });
      const after = await p.cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
      if (review.status !== 'closed' || review.resolution !== 'retry' || !review.notes || !review.operatorName.includes('李明')) throw new Error('处理人、说明或结论未持久化');
      if (approval.status !== 'pending' || after.amountMinor !== before.amountMinor) throw new Error('Manual continuation bypassed user confirmation.');
      if (await p.auditLog.count({ where: { dedupeKey: { startsWith: `manual:${review.id}:` } } }) !== 2) throw new Error('缺少转人工/处理结论审计');

      // A second fixture is unknown, not failed: the browser must offer stop/annotation only.
      const unknown = await p.pendingAction.create({ data: { sessionId, userId: 'user_liming', toolName: 'freeze_card',
        argsJson: '{"cardId":"card_credit"}', summaryJson: '{}', riskLevel: 'YELLOW', status: 'needs_reconciliation', userRequest: '结果不明的冻结操作' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const unknownReason = page.getByRole('textbox', { name: t('tasks.manual.formLabel', {
        label: t('tasks.manual.reasonLabel'), title: unknown.userRequest!,
      }), exact: true });
      await unknownReason.fill('冻结结果不明，请登记人工核对');
      await page.locator('section').filter({ has: unknownReason }).getByRole('button', { name: t('tasks.manual.handoff'), exact: true }).click();
      const notes = page.getByRole('textbox', { name: t('tasks.manual.formLabel', {
        label: t('tasks.manual.notesLabel'), title: unknown.userRequest!,
      }), exact: true });
      await notes.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      if (await page.getByRole('button', { name: t('tasks.manual.saveAndRetry'), exact: true }).count()) throw new Error('未知结果不应提供继续入口');
      await notes.fill('执行证据不足，记录说明并结束自动处理，保留待核对状态');
      await page.getByRole('button', { name: t('tasks.manual.stop'), exact: true }).click();
      await page.getByText(t('tasks.manual.resolved'), { exact: true }).nth(1).waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const current = await p.pendingAction.findUniqueOrThrow({ where: { id: unknown.id } });
      if (current.status !== 'needs_reconciliation' || current.resultJson !== null) throw new Error('人工说明改写了未知交易事实');
      return '失败任务→转人工→刷新保留→阻止直接重试→记录处理人/说明→继续后仍待用户确认；未知结果只登记/结束，保留待核对状态；两阶段审计齐全';
    } finally { await p.$disconnect(); }
  }, { label: 'g-manual-handoff' });
}
