import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { contentToText } from './conversation';

/** Narrate tool facts while preserving blocked and failed outcomes. */
export function narrate(result: ToolResultMessage): AssistantMessage {
  const raw = contentToText(result.content).trim();
  const blocked = raw.includes('__SECURITY_BLOCK__') ||
    /等待确认|等待验证|awaiting|需你确认|需进行安全验证|验证码|\bMFA\b/i.test(raw);
  const label = toolLabels[result.toolName] ?? result.toolName;
  if (blocked) {
    if (/require_mfa|验证码|\bMFA\b|等待验证|需进行安全验证/i.test(raw)) {
      return fauxAssistantMessage(
        `这笔操作（${label}）属于高风险操作，需要你完成安全验证（输入 6 位短信验证码）后才会执行。` +
        '目前状态为「等待验证」，尚未执行。请按提示完成验证。',
      );
    }
    if (/deny|熔断|锁定/i.test(raw)) {
      return fauxAssistantMessage(
        `当前会话已触发安全熔断，高风险操作已被锁定（${label} 未执行）。请前往安全中心解除限制后再试。`,
      );
    }
    return fauxAssistantMessage(
      `这笔操作（${label}）需要你确认后才会执行，目前状态为「等待确认」，尚未执行。请你确认后我才会为你执行。`,
    );
  }
  if (result.isError) {
    return fauxAssistantMessage(`抱歉，${label}未能成功完成：${raw || '工具返回了失败，但没有提供更多信息。'}`);
  }
  return fauxAssistantMessage(`${narrationLeads[result.toolName] ?? '操作已完成：'}${raw || '操作已完成。'}`);
}

const narrationLeads: Record<string, string> = {
  get_balance: '你的账户情况如下：',
  get_transactions: '这是你近期的交易明细：',
  analyze_spending: '消费分析结果：',
  detect_anomaly: '异常消费检测结果：',
  get_cards: '你的卡片信息：',
  list_subscriptions: '你当前的订阅情况：',
  list_investments: '为你查到的理财产品：',
  compare_investments: '理财对比结果：',
  get_investment_holdings: '你的理财持仓：',
  get_dashboard_summary: '资产概览：',
  list_scheduled_tasks: '你的定时任务：',
  search_contact: '联系人查询结果：',
  transfer_money: '转账处理结果：',
  reserve_budget: '预留预算结果：',
  submit_plan: '任务计划：',
  set_card_limit: '额度设置结果：',
  freeze_card: '冻结卡片结果：',
  unfreeze_card: '解冻卡片结果：',
  report_lost_card: '卡片挂失结果：',
  apply_virtual_card: '虚拟卡申请结果：',
  cancel_subscription: '取消订阅结果：',
  set_subscription_reminder: '订阅提醒设置结果：',
  subscribe_investment: '理财申购结果：',
  redeem_investment: '理财赎回结果：',
  create_scheduled_task: '定时任务创建结果：',
};

const toolLabels: Record<string, string> = {
  get_balance: '余额查询', get_transactions: '交易明细查询', search_contact: '联系人查询',
  transfer_money: '转账', analyze_spending: '消费分析', detect_anomaly: '异常检测',
  get_cards: '卡片查询', set_card_limit: '额度设置', freeze_card: '冻结卡片',
  unfreeze_card: '解冻卡片', report_lost_card: '卡片挂失', apply_virtual_card: '虚拟卡申请',
  list_subscriptions: '订阅查询', cancel_subscription: '取消订阅', set_subscription_reminder: '订阅提醒',
  list_investments: '理财产品查询', compare_investments: '理财对比', get_investment_holdings: '理财持仓查询',
  subscribe_investment: '理财申购', redeem_investment: '理财赎回', reserve_budget: '预留预算',
  list_scheduled_tasks: '定时任务查询', create_scheduled_task: '创建定时任务',
  get_dashboard_summary: '资产概览', submit_plan: '任务计划',
};
