import type { ChatCard } from '../../lib/contracts/agent';
import type { TaskPlan } from '../../lib/contracts/task';
import type { PendingAction } from '../../lib/contracts/security';
import type { BalanceView, TransferResult, SpendingAnalysis, AnomalyReport, CardView,
  ProductView, HoldingView, SubscriptionView, TransactionView } from '../../banking-sdk/types';
import type { ScheduleInbox } from '../../lib/contracts/schedule';
import { formatCNY } from '../../lib/money';
import { formatDecimalCNY, rateRatioToPercent } from '../../lib/decimal';
import { formatDateTime } from '../../lib/date';

const LABELS: Record<string, string> = {
  pending: '等待确认', awaiting_mfa: '等待验证码', confirmed: '已确认，正在处理', executed: '已执行', failed: '失败',
  cancelled: '已取消', locked: '已锁定', needs_reconciliation: '结果待人工核对', processing: '处理中',
  recoverable: '可恢复原操作', reconciliation: '结果待人工核对', running: '执行中', paused: '已暂停',
  waiting_confirmation: '等待操作确认', waiting_verification: '等待验证码', success: '已完成', skipped: '已跳过',
  ACTIVE: '正常', FROZEN: '已冻结', LOST: '已挂失', PENDING: '待开通', HOLDING: '持有中', REDEEMED: '已赎回',
  CANCELLED: '已取消', SCHEDULED: '尚未到期分发', DISPATCHING: '正在分发', AWAITING_CONFIRMATION: '等待确认或验证',
  DONE: '已完成', FAILED: '失败', CHECKING: '活期账户', SAVINGS: '储蓄账户', CREDIT: '信用卡', DEBIT: '借记卡', VIRTUAL: '虚拟卡',
  MONTHLY: '月', QUARTERLY: '季度', YEARLY: '年', REMINDER: '提醒', PAYMENT: '付款', TRANSFER: '转账',
  RESERVED: '已登记', USED: '已使用', RELEASED: '已释放',
};
export const label = (value: string): string => LABELS[value] || value;
const LIMIT = 20;
function rows<T>(items: T[], render: (item: T) => string): string {
  if (!Array.isArray(items)) throw new Error('Invalid public list');
  return items.slice(0, LIMIT).map(render).join('\n') +
    (items.length > LIMIT ? `\n仅展示前 ${LIMIT} 条，共 ${items.length} 条；可缩小查询范围。` : '');
}
const phone = (value: string) => /^\d{11}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : value;

/** 不显示计划参数、节点原始 output 或调试信息。 */
export function renderPlan(plan: TaskPlan): string {
  const available: string[] = [];
  if (['pending', 'running', 'waiting_confirmation'].includes(plan.status)) available.push(`/暂停 ${plan.id}`, `/取消任务 ${plan.id}`);
  if (plan.status === 'paused') available.push(`/继续 ${plan.id}`, `/取消任务 ${plan.id}`);
  if (plan.status === 'failed') available.push(`/重试 ${plan.id}`, `/取消任务 ${plan.id}`);
  if (plan.results.some(node => node.status === 'success' && ['reserve_budget', 'create_scheduled_task'].includes(node.tool || ''))) {
    available.push(`/回退记录 ${plan.id}`, '回退仅撤回可撤销记录，不撤销已入账交易。');
  }
  return [`任务：${plan.goal}`, `任务编号：${plan.id}`, `状态：${label(plan.status)}`,
    ...plan.nodes.map(node => `${node.name}：${label(plan.results.find(result => result.id === node.id)?.status || 'pending')}`),
    ...plan.results.filter(result => result.compensation).map(result => `${result.name}：${result.compensation!.message}`),
    ...available].join('\n');
}

/** 对齐 Web ChatCard 的全部公开字段；金额只做显示格式化，不改业务数值。 */
export function renderBusinessCard(card: ChatCard): string {
  try { return renderCard(card); }
  catch { return '服务端结果字段不完整，请在网页核对；未据此推断业务成功或余额。'; }
}
function renderCard(card: ChatCard): string {
  switch (card.type) {
    case 'balance': {
      const data = card.data as BalanceView;
      return `账户余额\n${rows(data.accounts, account => `${account.name} ${account.numberMasked}：${formatCNY(account.balance)}`)}\n合计可用：${formatCNY(data.totalAvailable)}`;
    }
    case 'transfer': {
      const data = card.data as TransferResult;
      return [`转账${data.success ? '成功' : '失败'}`, `收款人：${data.recipient.name}（${phone(data.recipient.phone)}）`,
        `金额：${formatCNY(data.amount)}`, `转账后余额：${formatCNY(data.newBalance)}`,
        `流水编号：${data.transactionId}`, data.remark ? `备注：${data.remark}` : ''].filter(Boolean).join('\n');
    }
    case 'transactions': {
      const data = card.data as TransactionView[];
      return `交易记录（${data.length} 条）\n${rows(data, row => `${formatDateTime(row.occurredAt)} ${row.merchant} ${formatCNY(row.amount)}（${row.category}${row.isAnomaly ? '，可疑交易' : ''}）`) || '没有匹配的交易。'}`;
    }
    case 'spending': {
      const data = card.data as SpendingAnalysis;
      return [`${data.month} 消费分析`, `已入账消费：${formatCNY(data.bookedTotal)}`, `其中可疑消费：${formatCNY(data.flaggedTotal)}`,
        `上月：${formatCNY(data.prevTotal)}；环比：${data.momChangePct}%`, rows(data.byCategory, row => `${row.category}：${formatCNY(row.amount)}（${row.share}%）`)].join('\n');
    }
    case 'anomaly': {
      const data = card.data as AnomalyReport;
      return `可疑交易检查：扫描 ${data.scanned} 条，发现 ${data.anomalies.length} 条\n${rows(data.anomalies, item =>
        `${formatDateTime(item.transaction.occurredAt)} ${item.transaction.merchant} ${formatCNY(item.transaction.amount)}：${item.reason}${item.acknowledged ? '（已确认为本人交易）' : ''}`)}`;
    }
    case 'cards': return `卡片\n${rows(card.data as CardView[], row => [
      `${label(row.type)} ${row.numberMasked}：${label(row.status)}`,
      row.creditLimit === undefined ? '' : `${row.status === 'LOST' ? '原卡历史授信（不计入当前可用额度）' : '授信'}：${formatCNY(row.creditLimit)}；${row.status === 'LOST' ? '原卡历史可用记录' : '可用授信'}：${row.availableLimit === undefined ? '未提供' : formatCNY(row.availableLimit)}`,
      row.linkedAccountNumber ? `结算账户：${row.linkedAccountNumber}` : '',
      row.accountAvailableBalance === undefined ? '' : `账户可用余额：${formatCNY(row.accountAvailableBalance)}`,
      row.monthlyLimit === undefined ? '' : `月消费限额：${formatCNY(row.monthlyLimit)}`,
      row.payableAmount === undefined ? '' : `当前可支付：${formatCNY(row.payableAmount)}`,
      ...(row.limits || []).map(limit => `${limit.category}消费限额：${formatCNY(limit.amount)}`),
    ].filter(Boolean).join('\n'))}`;
    case 'investments': {
      const data = card.data as { products?: ProductView[]; holdings?: HoldingView[] };
      const parts: string[] = [];
      if (data.products) parts.push(`理财产品\n${rows(data.products, row => `${row.name}（${row.code}，${row.riskLevel}）\n预期年化 ${rateRatioToPercent(row.annualYieldRate)}%，期限 ${row.termDays} 天，起购 ${formatCNY(row.minAmount)}`) || '没有匹配产品。'}`);
      if (data.holdings) parts.push(`理财持仓\n${rows(data.holdings, row => `${row.productName}：${label(row.status)}\n本金 ${formatCNY(row.amount)}；市值 ${row.marketValue === undefined ? '未提供' : formatDecimalCNY(row.marketValue)}；收益 ${row.profit === undefined ? '未提供' : formatDecimalCNY(row.profit)}`) || '没有持仓。'}`);
      return parts.join('\n\n') || '没有可展示的理财结果。';
    }
    case 'subscriptions': return `订阅与代扣\n${rows(card.data as SubscriptionView[], row =>
      `${row.name}：${label(row.status)}，${formatCNY(row.amount)}/${label(row.cycle)}\n${row.status === 'ACTIVE' ? `下次扣费：${formatDateTime(row.nextChargeAt)}；` : '已取消续费；'}续费提醒：${row.remind ? '已开启' : '未开启'}`) || '没有订阅。'}`;
    case 'contacts': return `联系人\n${rows(card.data, row => `${row.name}（${phone(row.phone)}${row.bank ? `，${row.bank}` : ''}）${row.remark ? `：${row.remark}` : ''}`) || '没有匹配的联系人。'}`;
    case 'dashboard': return [`资产总览`, `总资产：${formatCNY(card.data.totalAssets)}`, `活期余额：${formatCNY(card.data.checkingBalance)}`,
      `可用授信：${formatCNY(card.data.creditAvailable)}`, `${card.data.month} 已入账消费：${formatCNY(card.data.monthSpend)}`].join('\n');
    case 'scheduled': return `${card.created ? '已创建定时任务' : '定时任务'}\n${rows(card.data, row => `${row.name}：${label(row.kind)}，${formatDateTime(row.runAt)}，${label(row.status)}${row.requiresConfirmation ? '；到期仍需确认或验证' : ''}`) || '没有定时任务。'}\n到期后可发送 /检查到期，后台不会代替用户确认付款。`;
    case 'receipt': {
      const data = card.data;
      if (data.kind === 'budget') return `预算记录：${data.name}\n金额：${formatCNY(data.amount)}\n状态：${label(data.status)}\n仅保存预算记录，不冻结或转移账户资金。`;
      return [`${data.kind === 'investmentPurchase' ? '理财申购' : '理财赎回'}${data.success ? '成功' : '失败'}`,
        `结算金额：${formatCNY(data.amount)}`, `账户余额：${formatCNY(data.newBalance)}`, `时间：${formatDateTime(data.occurredAt)}`].join('\n');
    }
    case 'plan': return renderPlan(card.plan);
    case 'error': return `业务提示：${card.message}`;
    case 'confirmation': case 'mfa': return ''; // 授权入口由 renderEvents 集中处理。
    default: { const exhaustive: never = card; return exhaustive; }
  }
}

export type SurfacedAction = PendingAction & { attention?: 'decision' | 'processing' | 'recoverable' | 'reconciliation' };
export function renderAttention(action: SurfacedAction): string | undefined {
  if (['pending', 'awaiting_mfa'].includes(action.status) && (!action.attention || action.attention === 'decision')) return undefined;
  return [`操作：${action.summary.title}`, `操作编号：${action.id}`, `状态：${label(action.attention || action.status)}`,
    action.attention === 'recoverable' ? `恢复原操作：/恢复操作 ${action.id}` : '',
    '该记录不能重新确认；结果不明时请核对操作记录，不要重复办理。'].filter(Boolean).join('\n');
}

export function renderScheduleInbox(inbox: ScheduleInbox): string {
  return [`定时任务`, rows(inbox.tasks, row => `${row.name}（${row.id}）\n${formatDateTime(row.runAt)}：${label(row.status)}`) || '没有任务。',
    '提醒通知', rows(inbox.notifications, row => `${formatDateTime(row.createdAt)}：${row.message}`) || '没有通知。',
    '发送 /检查到期 可执行一次服务器到期检查；付款仍需确认或验证。'].join('\n');
}
