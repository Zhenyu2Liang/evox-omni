import type { BankingChannel } from './banking-client';
import { renderAction } from './banking-client';
import type { WeixinState } from './state';
import { renderAttention, renderPlan, renderScheduleInbox, type SurfacedAction } from './presentation';
import { offerActionReference } from './action-references';

export const HELP = [
  ['1. 直接描述需求',
    '查询余额、账单、可疑交易、联系人、卡片、理财、订阅或定时任务。',
    '办理转账、理财申赎、卡片控制等业务。'].join('\n'),
  ['2. 确认与验证',
    '/确认　确认当前这一笔',
    '/验证 六位验证码　验证当前这一笔',
    '/取消　取消当前这一笔',
    '核对详情后再确认；需要安全验证时，先确认再验证。',
    '多笔操作逐笔显示，每笔分别确认。',
    '仍可指定短编号或完整编号，例如 /确认 1。',
    '仅回复“确认”不会授权。'].join('\n'),
  ['3. 待办与恢复',
    '/待办　查看待处理操作',
    '/恢复操作 操作编号　恢复原操作'].join('\n'),
  ['4. 任务计划',
    '/任务　查看任务列表',
    '/任务 任务编号　查看指定任务',
    '/暂停 任务编号',
    '/继续 任务编号',
    '/重试 任务编号',
    '/取消任务 任务编号',
    '/回退记录 任务编号'].join('\n'),
  ['5. 定时任务',
    '/定时任务　查看定时任务和提醒',
    '/检查到期　检查已到期任务',
    '到期付款仍需确认和验证。'].join('\n'),
  ['6. 使用范围',
    '新建实体卡、注销卡片及开发者维护功能请在网页办理。',
    '仅支持绑定用户的文字私聊。',
    '/帮助　重新查看本说明'].join('\n'),
].join('\n\n');

export function decisionActions(actions: SurfacedAction[]): SurfacedAction[] {
  return [...new Map(actions.filter(action => ['pending', 'awaiting_mfa'].includes(action.status) &&
    (!action.attention || action.attention === 'decision')).map(action => [action.id, action])).values()];
}

/** Full server snapshot: preserve queue order and show exactly one decision at a time. */
export function offerActions(actions: SurfacedAction[], state: WeixinState): string {
  const decisions = decisionActions(actions);
  const byId = new Map(decisions.map(action => [action.id, action]));
  state.confirmationQueue = [...new Set(state.confirmationQueue)].filter(id => byId.has(id));
  for (const action of [...decisions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (!state.confirmationQueue.includes(action.id)) state.confirmationQueue.push(action.id);
  }
  if (!state.activeActionId || !byId.has(state.activeActionId)) state.activeActionId = state.confirmationQueue[0];
  const current = state.activeActionId ? byId.get(state.activeActionId) : undefined;
  const parts: string[] = [];
  if (current) {
    const reference = offerActionReference(state, current.id);
    const remaining = decisions.length - 1;
    parts.push(`当前待确认操作\n${renderAction(current.id, current.summary, reference, true)}\n状态：${current.status === 'awaiting_mfa' ? '等待验证码' : '等待确认'}`);
    if (remaining) parts.push(`还有 ${remaining} 笔待处理，当前操作结束后逐笔显示。`);
  }
  parts.push(...actions.filter(action => !byId.has(action.id)).slice(0, 20).map(action => {
    const reference = offerActionReference(state, action.id);
    return renderAttention(action, reference) || '';
  }));
  return parts.filter(Boolean).join('\n\n') || '没有待处理的操作。';
}

/** 控制完成后重新读取服务端节点关联，补发继续执行产生的确认入口。 */
async function presentPlan(id: string, bank: BankingChannel, state: WeixinState): Promise<string> {
  const plan = await bank.plan(id);
  state.plans[plan.id] = true;
  const actionIds = new Set(plan.results.map(result => {
    const enriched = result as typeof result & { pendingActionId?: string };
    const output = typeof result.output === 'object' && result.output !== null ? result.output as { pendingActionId?: string } : undefined;
    return enriched.pendingActionId || output?.pendingActionId;
  }).filter((value): value is string => typeof value === 'string'));
  const actions = actionIds.size ? await bank.actions() : [];
  return [renderPlan(plan), actions.length ? offerActions(actions, state) : ''].filter(Boolean).join('\n\n');
}

export async function handleChannelCommand(text: string, bank: BankingChannel, state: WeixinState): Promise<string | undefined> {
  if (text === '/帮助' || text === '/help') return HELP;
  if (text === '/待办') return offerActions(await bank.actions(), state);
  if (text === '/任务') {
    const plans = (await bank.plans()).slice(0, 20);
    for (const plan of plans) state.plans[plan.id] = true;
    return plans.map(renderPlan).join('\n\n') || '没有多步任务。';
  }
  if (text === '/定时任务') return renderScheduleInbox(await bank.schedules());
  if (text === '/检查到期') {
    const result = await bank.tickSchedules();
    const workflowIds = [...new Set(result.dispatches.flatMap(item => item.workflowId ? [item.workflowId] : []))];
    const plans: string[] = [];
    for (const id of workflowIds) plans.push(await presentPlan(id, bank, state));
    return [renderScheduleInbox(await bank.schedules()), ...plans].join('\n\n');
  }
  const match = /^\/(任务|暂停|继续|重试|取消任务|回退记录)\s+([A-Za-z0-9_-]{1,128})$/.exec(text);
  if (!match) return undefined;
  const [, verb, id] = match;
  if (verb === '任务') return presentPlan(id, bank, state);
  if (!state.plans[id]) return '请先发送 /任务 查看服务端任务和编号，再控制指定任务。';
  const controls: Record<string, 'pause' | 'resume' | 'retry' | 'cancel' | 'rollback'> = {
    暂停: 'pause', 继续: 'resume', 重试: 'retry', 取消任务: 'cancel', 回退记录: 'rollback',
  };
  await bank.controlPlan(id, controls[verb]);
  return presentPlan(id, bank, state);
}
