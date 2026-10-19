import type { BankingChannel } from './banking-client';
import { renderAction } from './banking-client';
import type { WeixinState } from './state';
import { renderAttention, renderPlan, renderScheduleInbox, type SurfacedAction } from './presentation';

export const HELP = [
  '可查询余额、账单、异常交易、联系人、卡片、理财、订阅和定时任务，也可描述转账、理财申赎、卡片控制等业务。',
  '核对详情后使用 /确认 操作编号；红色操作再用 /验证 操作编号 六位验证码；/取消 操作编号。聊天中只说“确认”不会授权。',
  '/待办 查看服务端待处理操作；/恢复操作 操作编号 恢复原结果。',
  '/任务 [任务编号]；/暂停 任务编号；/继续 任务编号；/重试 任务编号；/取消任务 任务编号；/回退记录 任务编号。',
  '/定时任务；/检查到期（付款到期仍需确认和验证）；/帮助。',
  '新建全新实体卡、注销卡片及开发者维护功能请在网页办理。仅支持绑定用户的文字私聊。',
].join('\n');

export function offerActions(actions: SurfacedAction[], state: WeixinState): string {
  return actions.slice(0, 20).map(action => {
    state.offered[action.id] ??= { confirmed: false };
    return renderAttention(action) || `${renderAction(action.id, action.summary)}\n状态：${action.status === 'awaiting_mfa' ? '等待验证码' : '等待确认'}`;
  }).join('\n\n') || '没有待处理的操作。';
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
  const actions = actionIds.size ? (await bank.actions()).filter(action => actionIds.has(action.id)) : [];
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
