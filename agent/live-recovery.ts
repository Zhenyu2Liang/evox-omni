import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { TOOL_POLICY } from '@/security/permission-engine';
import type { ToolName } from '@/lib/contracts/tools';
import type { FactInput } from './grounding-facts';

// These patterns select a bounded planning retry only. They never choose a banking tool,
// fill arguments, authorize a write or replace normal server-side request constraints.
const WRITE_REQUEST = /转账|转给|给.{1,30}转|申购|认购|购买.{0,20}(?:基金|理财)|赎回|冻结|解冻|挂失|申请.{0,10}卡|预留|(?:设置|调整).{0,15}(?:限额|提醒)|取消.{0,20}订阅|(?:创建|设置).{0,20}(?:任务|提醒)|修改密码/;
const READ_REQUEST = /查询|查一下|查下|余额|账单|消费|流水|持仓|银行卡|订阅|对比|比较/;

export function startedMutation(events: readonly AgentStreamEvent[]): boolean {
  return events.some(event => event.type === 'plan_update' || event.type === 'confirmation_required' ||
    event.type === 'mfa_required' || (event.type === 'tool_start' &&
      (event.toolEvent.toolName === 'submit_plan' || !TOOL_POLICY[event.toolEvent.toolName as ToolName] ||
       TOOL_POLICY[event.toolEvent.toolName as ToolName].write)));
}

export function transientModelFailure(error: string | undefined): boolean {
  if (!error || /(?:\b400\b|\b401\b|\b403\b|api.?key|authentication|unauthor|tool_calls|bad request)/i.test(error)) return false;
  return /timed?\s*out|timeout|超时|\b(?:408|429|500|502|503|504)\b|rate.?limit|network|fetch failed|connection|ECONN/i.test(error);
}

export function unfinishedPlanning(request: string, events: readonly AgentStreamEvent[], facts: readonly FactInput[], guidance: boolean): boolean {
  if (guidance || startedMutation(events) || facts.some(fact => !fact.result.ok) ||
      events.some(event => event.type === 'security_event' && event.kind === 'locked')) return false;
  return WRITE_REQUEST.test(request) || (READ_REQUEST.test(request) && facts.length === 0);
}

export function canRecoverPlanning(request: string, events: readonly AgentStreamEvent[], facts: readonly FactInput[], guidance: boolean, failure?: string): boolean {
  if (guidance || startedMutation(events) || facts.some(fact => !fact.result.ok) ||
      events.some(event => event.type === 'security_event' && event.kind === 'locked')) return false;
  // A read result already supplies the answer; a narration timeout need not query it again.
  if (!WRITE_REQUEST.test(request) && facts.length > 0) return false;
  return failure ? transientModelFailure(failure) : unfinishedPlanning(request, events, facts, guidance);
}

export const PLANNING_RECOVERY_INSTRUCTION = '上一次响应没有完成本次用户需求的规划，且本次尚未进入任何写操作。保留已有查询结果，继续处理原始用户请求；信息完整时调用银行工具或 submit_plan 生成办理入口。缺信息、对象歧义或能力不支持时，只返回输出要求中的严格 guidance JSON。不要仅口头要求确认，也不要猜参数、替换对象或绕过确认/MFA。';

export function recoveryNotice(events: readonly AgentStreamEvent[], failure?: string, request = '', facts: readonly FactInput[] = []): string {
  const reason = !failure ? '模型未完成业务规划' : /timed?\s*out|timeout|超时/i.test(failure)
    ? '模型响应超时' : /401|403|api.?key|authentication|unauthor/i.test(failure)
      ? '模型连接或认证配置异常' : '模型响应中断';
  if (events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')) {
    return `${reason}，但确认或验证入口已生成。请核对已有操作卡并继续办理，不要重新提交同一笔业务。`;
  }
  if (events.some(event => event.type === 'plan_update')) {
    return `${reason}，计划和已记录结果已保留。请查看计划卡；等待确认时使用已有操作卡，失败节点通过计划的重试入口处理，不要重新提交整个需求。`;
  }
  if (startedMutation(events)) {
    return `${reason}，操作已进入执行流程。请查看系统结果；结果不明确时刷新核对或使用人工核对入口，请勿重复办理。`;
  }
  if (facts.length && !WRITE_REQUEST.test(request)) {
    return `${reason}，已取得的查询结果已保留。请查看上述系统结果，本次不会重复查询。`;
  }
  if (failure && !transientModelFailure(failure)) {
    return `${reason}，尚未生成办理入口。请检查模型配置或连接后再提交原需求。`;
  }
  return `${reason}，尚未生成办理入口；已停止自动重试。可点击“重试规划”继续处理原需求，或补充说明后重新发送。`;
}
