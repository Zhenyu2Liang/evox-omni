/**
 * The UI's financial narrative is authored here, from tool results only. Normal conversation uses
 * a separate presentation path. Model prose cannot select a financial operation or its result.
 * Tool summaries below are produced by the registered SDK runners, not by the model. The planning
 * tool is handled separately because its goal/node descriptions originate from model arguments.
 */
import { formatCNY } from '@/lib/money';
import { buildFinancialFacts, isRecord, SIDE_EFFECT_TOOLS, type FactInput, type TrustedWrite } from './grounding-facts';
import { renderBankingGuidance, type BankingGuidance } from './banking-guidance';
import conversationMessages from './messages/conversation.zh-CN.json';

export const UNVERIFIED_RESPONSE = conversationMessages.unverified;
export const UNAVAILABLE_RESPONSE = conversationMessages.unavailable;

const WRITE_LABELS: Readonly<Record<string, string>> = {
  transfer_money: '转账', reserve_budget: '预算预留', set_card_limit: '分类消费限额调整',
  freeze_card: '卡片冻结', unfreeze_card: '卡片解冻', report_lost_card: '卡片挂失',
  replace_card: '卡片补办', apply_virtual_card: '虚拟卡申请', cancel_subscription: '订阅取消',
  set_subscription_reminder: '订阅提醒', create_scheduled_task: '定时任务记录',
  subscribe_investment: '理财申购', redeem_investment: '理财赎回',
};

const READ_LABELS: Readonly<Record<string, string>> = {
  get_transactions: '交易记录', search_contact: '联系人查询', analyze_spending: '账单分析',
  detect_anomaly: '异常检测', get_cards: '卡片查询', list_subscriptions: '订阅查询',
  list_investments: '理财产品', compare_investments: '产品对比',
  get_investment_holdings: '理财持仓', get_dashboard_summary: '资产概览',
  list_scheduled_tasks: '定时任务查询',
};

export { financialOperationKey } from './financial-operation-key';

function renderWrite(write: TrustedWrite, ordinal: number): string {
  const label = WRITE_LABELS[write.toolName] ?? '银行操作';
  const resultLabel = write.toolName === 'subscribe_investment' || write.toolName === 'redeem_investment'
    ? `${label}结果` : `${label}处理结果`;
  const lead = `${resultLabel}：第${ordinal}笔操作`;
  if (write.outcome === 'unknown') return `${lead}待核对，请通过操作记录或人工核实。`;
  if (write.outcome === 'failed') return `${lead}实际执行失败${write.error ? `：${write.error}` : '。'}`;
  const details: string[] = [`${lead}实际执行成功`];
  if (write.recipient?.name) details.push(`收款人 ${write.recipient.name}`);
  if (write.amount !== undefined) details.push(`金额 ${formatCNY(write.amount)}`);
  if (write.balanceAfter !== undefined) details.push(`执行时账户余额 ${formatCNY(write.balanceAfter)}`);
  // Non-money writes have their own server-authored SDK summaries (card/category/holding details).
  if (write.toolName !== 'transfer_money' && write.summary) details.push(write.summary);
  return `${details.join('；')}。`;
}

export interface FinancialResponseOptions {
  pending?: 'confirmation' | 'mfa';
  /** Original USER request, only echoed as a request; never a financial result or model prose. */
  requestText?: string;
  locked?: boolean;
  guidance?: BankingGuidance;
  /**
   * Declared-but-unsubmitted write capabilities for the current turn (model interpretation). When
   * present with no executed write and no pending gate, the server states the true outcome instead
   * of letting prose assert a confirmation panel that no `PendingAction` backs.
   */
  declared?: readonly string[];
}

/** Always renders the actual operations in result order; there is no prose-to-operation matching. */
export function renderFinancialResponse(
  entries: readonly FactInput[],
  options: FinancialResponseOptions = {},
): string {
  const facts = buildFinancialFacts(entries);
  const sections: string[] = [];
  if (options.locked) return '账户已安全锁定，请先在安全中心处理。';
  if (facts.currentBalances.length > 0) {
    const lines = facts.currentBalances.map(account => account.balanceKnown === false
      ? `${account.name ?? account.type ?? '账户'}当前余额待核对`
      : `${account.name ?? account.type ?? '账户'}当前余额为 ${formatCNY(account.balance)}`);
    if (facts.totalBalance !== undefined) lines.push(`账户可用余额合计为 ${formatCNY(facts.totalBalance)}`);
    else lines.push('账户可用余额合计待核对');
    sections.push(`${lines.join('；')}。`);
  }
  facts.writes.forEach((write, index) => sections.push(renderWrite(write, index + 1)));

  // Only the latest read of each type is described. Balance reads were rendered from the current
  // ledger above, so a pre-transfer summary cannot restore an old balance/total.
  const reads = new Map<string, FactInput>();
  for (const entry of entries) if (!SIDE_EFFECT_TOOLS.has(entry.toolName) && (entry.toolName !== 'get_balance' || !entry.result.ok)) reads.set(entry.toolName, entry);
  for (const entry of reads.values()) {
    if (entry.toolName === 'submit_plan') {
      const plan = isRecord(entry.result.data) ? entry.result.data : undefined;
      const status = plan?.status;
      const labels: Readonly<Record<string, string>> = {
        success: '已完成', failed: '执行失败', cancelled: '已取消', paused: '已暂停',
        waiting_confirmation: '等待确认', waiting_verification: '等待验证码验证',
        running: '执行中', pending: '等待执行',
      };
      sections.push(`计划状态：${typeof status === 'string' ? labels[status] ?? '请查看计划卡片' : '请查看计划卡片'}。`);
      continue;
    }
    const label = entry.toolName === 'get_balance' ? '余额查询' : READ_LABELS[entry.toolName];
    if (!label) continue; // Unknown/model-invented tools are never authoritative sources.
    if (!entry.result.ok) sections.push(`${label}未取得结果${entry.result.error ? `：${entry.result.error}` : '。'}`);
    else if (entry.result.summary) sections.push(`${label}（查询时结果）：${entry.result.summary}`);
    else if (entry.toolName === 'analyze_spending' && isRecord(entry.result.data) && typeof entry.result.data.total === 'string') {
      sections.push(`账单分析：消费合计 ${formatCNY(entry.result.data.total)}。`);
    } else sections.push(`${label}已查询，请查看系统结果卡片。`);
  }
  if (options.pending === 'mfa') sections.push('该操作尚未执行，等待验证码验证。');
  else if (options.pending === 'confirmation') sections.push('该操作尚未执行，等待确认，请本人核对操作卡片。');
  // A declared operation with neither an executed write nor a real gate is reported from server
  // evidence (the model declaration), so no unverified prose can assert a non-existent panel.
  const declaredUnsubmitted = (options.declared?.length ?? 0) > 0 && facts.writes.length === 0 && !options.pending;
  if (declaredUnsubmitted) {
    const labels = options.declared!.map(tool => WRITE_LABELS[tool] ?? tool);
    sections.push(conversationMessages.declared_unsubmitted.replace('{operations}', labels.join('、')));
  }
  // Guidance is not execution evidence and cannot contradict an actual write or pending gate.
  if (options.guidance && facts.writes.length === 0 && !options.pending && !declaredUnsubmitted) {
    const request = 'fields' in options.guidance && options.requestText
      ? `针对你的需求 ${JSON.stringify(options.requestText.slice(0, 200))}，` : '';
    sections.push(request + renderBankingGuidance(options.guidance));
  }
  if (sections.length) return sections.join('\n');
  // Missing/invalid guidance is not evidence of a specific missing field or capability boundary.
  // Keep this fallback short, and never echo a guessed interpretation back into model history.
  return UNVERIFIED_RESPONSE;
}
