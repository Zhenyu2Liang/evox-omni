import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { scheduledTaskFields, projectScheduledSummary } from '@/security/scheduled-summary';
import { securityGateway } from '@/security/security-gateway';
import { ActionDetails } from '@/components/chat/cards/ActionDetails';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { newSessionId } from '../../helpers/scenario';
import { getDemoSession } from '@/agent/session';
import { GET as getActions } from '@/app/api/actions/route';
import { NextRequest } from 'next/server';

useFreshDatabase();
const payload = { contactId: 'contact_mama', amount: '5000.00', remark: '给妈妈的转账', sourceAccountId: 'acct_checking' };
const expected = [
  { label: '收款人', value: '妈妈' }, { label: '金额', value: '¥5,000.00' },
  { label: '付款账户', value: '活期账户 · ****8821' }, { label: '备注', value: '给妈妈的转账' },
];

describe('scheduled confirmation business details', () => {
  it('stores readable fields while keeping executable args and balances unchanged', async () => {
    const before = await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    const ctx = { userId: DEMO_USER_ID, sessionId: newSessionId(), toolName: 'create_scheduled_task' as const,
      userRequest: '下个月给妈妈转账', args: { name: '给妈妈转账', kind: 'TRANSFER', runAtLocal: '2026-11-01T09:00', payload } };
    const action = await securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
    expect(action.summary.fields).toEqual(expect.arrayContaining(expected));
    expect(action.summary.fields.some(field => field.value.includes('contact_mama') || field.value.includes('acct_checking'))).toBe(false);
    const stored = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(JSON.parse(stored.argsJson).payload).toEqual(payload);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
    expect(await getTestPrisma().scheduledTask.count({ where: { name: '给妈妈转账' } })).toBe(0);
  });
  it('projects old JSON snapshots without changing the original summary', async () => {
    const old: PendingActionSummary = { title: '创建定时任务', toolName: 'create_scheduled_task', tier: 'YELLOW', requiresMfa: false,
      fields: [{ label: '任务类型', value: 'TRANSFER' }, { label: '任务内容', value: JSON.stringify(payload) }] };
    const original = JSON.stringify(old);
    const projected = await projectScheduledSummary(DEMO_USER_ID, old);
    expect(projected.fields).toEqual([{ label: '任务类型', value: 'TRANSFER' }, ...expected]);
    expect(JSON.stringify(old)).toBe(original);
    const html = renderToStaticMarkup(createElement(ActionDetails, { action: projected }));
    expect(html).toContain('转账');
    expect(html).toContain('给妈妈的转账');
    expect(html).not.toContain('contact_mama');
    expect(html).not.toContain('TRANSFER');
  });
  it('restores old pending confirmations through HTTP without rewriting authorization rows', async () => {
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const ctx = { userId: DEMO_USER_ID, sessionId, toolName: 'create_scheduled_task' as const,
      userRequest: '定时转账', args: { name: '定时转账', kind: 'TRANSFER', runAtLocal: '2026-11-01T09:00', payload } };
    const action = await securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
    const summary = { ...action.summary, fields: [{ label: '任务类型', value: 'TRANSFER' }, { label: '任务内容', value: JSON.stringify(payload) }] };
    const before = await getTestPrisma().pendingAction.update({ where: { id: action.id }, data: { summaryJson: JSON.stringify(summary) } });
    const response = await getActions(new NextRequest('http://localhost/api/actions'));
    expect(response.status).toBe(200);
    const restored = (await response.json()).data.find((item: { id: string }) => item.id === action.id);
    expect(restored.summary.fields).toEqual(expect.arrayContaining(expected));
    expect(restored.args.payload).toEqual(payload);
    expect(await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).toEqual(before);
  });
  it('never resolves another user’s contact or account and hides unsupported payload fields', async () => {
    const foreign = await scheduledTaskFields('another-user', 'PAYMENT', payload);
    expect(foreign).toContainEqual({ label: '收款人', value: '收款人待核对' });
    expect(foreign).toContainEqual({ label: '付款账户', value: '账户待核对' });
    expect(JSON.stringify(foreign)).not.toContain('8821');
    expect(await scheduledTaskFields(DEMO_USER_ID, 'TRANSFER', { ...payload, code: 'secret' }))
      .toEqual([{ label: '任务内容', value: '任务内容待核对' }]);
  });
  it('preserves reminder text and escaped multiline remarks as text', async () => {
    const note = '{"note":"用户原文"}';
    expect(await scheduledTaskFields(DEMO_USER_ID, 'REMINDER', { note })).toEqual([{ label: '任务内容', value: note }]);
    const reminder: PendingActionSummary = { title: '提醒', toolName: 'create_scheduled_task', tier: 'YELLOW', requiresMfa: false,
      fields: [{ label: '任务类型', value: 'REMINDER' }, { label: '任务内容', value: note }] };
    expect(await projectScheduledSummary(DEMO_USER_ID, reminder)).toBe(reminder);
    const fields = await scheduledTaskFields(DEMO_USER_ID, 'PAYMENT', { ...payload, remark: '<script>alert(1)</script>\n原文' });
    const html = renderToStaticMarkup(createElement(ActionDetails, { action: { fields } }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
