/**
 * system-prompt.ts — the banking agent's system prompt builder.
 * MUST state: (a) the only capabilities are the REGISTERED tools; (b) the agent NEVER decides
 * permission — gated (🟡/🔴) tools are confirmed/verified by the human; (c) HALLUCINATION RULE:
 * report ONLY facts from a tool result, report `ok:false` as a failure, never invent balances/results,
 * never claim a gated tool executed; (d) no chain-of-thought — task steps/tool status/results only.
 *
 * PURE: the builder only reads `ctx` (no clock, no randomness). It lists ONLY the tool names present
 * in `ctx.toolNames`, so the prompt can never advertise a phantom capability.
 */
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import { RISK_LABEL } from '@/lib/constants';
import { demoNow } from '@/lib/clock';

export interface SystemPromptContext {
  userId: string;
  displayName?: string;
  /** The exact tool names registered for this session (prompt lists ONLY real capabilities). */
  toolNames: ToolName[];
}
/** Reusable prompt fragment asserting the hallucination rule (tests assert it is present). */
export const HALLUCINATION_RULE: string =
  'Only report facts that came from a tool result. If a tool reports failure (ok:false), report the failure. Never invent balances or results, and never claim a gated tool already executed.';

/** Prompt group for a tool. `DYNAMIC` = tier decided per call (amount/daily total); `META` = not gated. */
type TierHint = RiskLevel | 'DYNAMIC' | 'META';

/**
 * Prompt-level tier hint per registered tool — a HINT only. The AUTHORITATIVE tier is decided in
 * code by `security/permission-engine.ts` (+ the risk engine) at call time, never by the model. The
 * `Record<ToolName, …>` form is exhaustive: adding a tool to the frozen union is a compile error here.
 */
const TIER_HINT: Record<ToolName, TierHint> = {
  // 🟢 GREEN — auto-executed reads
  get_balance: 'GREEN',
  get_transactions: 'GREEN',
  search_contact: 'GREEN',
  analyze_spending: 'GREEN',
  detect_anomaly: 'GREEN',
  get_cards: 'GREEN',
  list_subscriptions: 'GREEN',
  list_investments: 'GREEN',
  compare_investments: 'GREEN',
  get_investment_holdings: 'GREEN',
  get_dashboard_summary: 'GREEN',
  list_scheduled_tasks: 'GREEN',
  reserve_budget: 'GREEN',
  // 🟡 YELLOW — require user confirmation
  set_card_limit: 'YELLOW',
  cancel_subscription: 'YELLOW',
  freeze_card: 'YELLOW',
  apply_virtual_card: 'YELLOW',
  set_subscription_reminder: 'YELLOW',
  create_scheduled_task: 'YELLOW',
  // 🔴 RED — require MFA verification
  subscribe_investment: 'RED',
  redeem_investment: 'RED',
  report_lost_card: 'RED',
  unfreeze_card: 'RED',
  change_password: 'RED',
  // dynamic / meta
  transfer_money: 'DYNAMIC',
  submit_plan: 'META',
};

/** Section order + header label for each prompt group. */
const GROUP_ORDER: readonly TierHint[] = ['GREEN', 'YELLOW', 'DYNAMIC', 'RED', 'META'];
const HINT_LABEL: Record<TierHint, string> = {
  GREEN: RISK_LABEL.GREEN,
  YELLOW: RISK_LABEL.YELLOW,
  RED: RISK_LABEL.RED,
  DYNAMIC: '🟡/🔴 动态',
  META: '📋 元工具',
};

/** Render the tool catalogue from `ctx.toolNames` only — never a name the session does not have. */
function renderToolList(toolNames: readonly ToolName[]): string {
  const lines: string[] = [];
  for (const hint of GROUP_ORDER) {
    const names = toolNames.filter((n) => TIER_HINT[n] === hint);
    if (names.length > 0) lines.push(`- ${HINT_LABEL[hint]}：${names.join('、')}`);
  }
  // Defensive: any name that somehow has no tier hint still gets listed (never silently dropped).
  const grouped = new Set<TierHint>(GROUP_ORDER);
  const leftover = toolNames.filter((n) => !grouped.has(TIER_HINT[n]));
  if (leftover.length > 0) lines.push(`- 其它：${leftover.join('、')}`);
  return lines.length > 0 ? lines.join('\n') : '（当前会话没有可用工具）';
}

/** Build the banking agent system prompt. PURE. */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const who =
    ctx.displayName !== undefined && ctx.displayName !== ''
      ? ctx.displayName
      : ctx.userId;

  return [
    `你是「智能银行助手」，一个服务于「${who}」的 AI 银行 Agent。`,
    '你负责理解用户的金融需求、规划任务、调用下方「可用工具」中的银行工具，并用自然语言向用户如实解释结果。',
    '',
    '## 最高安全原则（不可违背）',
    '1. 你可以决定「下一步做什么」，但绝不能决定「是否被允许做」。',
    '2. 是否允许、属于哪个风险等级、是否需要确认或验证码，全部由服务端代码（安全网关）判定；你无权判定、绕过或更改。',
    '3. 涉及资金变动的操作，只有在用户本人确认（或输入验证码验证）之后才会真正执行；模型文本永远不能触发资金划转。',
    '4. 当某个工具被拦截时，你会收到「等待用户确认/验证」的结果：此时只能如实告知用户正在等待，绝不能声称该操作已执行。',
    '5. 申请虚拟卡的月限额必须用 monthlyLimit 参数；备注不代表限额。其它未支持的约束要先说明和澄清。赎回是整笔持仓全额赎回，不支持部分赎回。',
    '',
    '## 权限分层（提示；实际以代码判定为准）',
    `- ${RISK_LABEL.GREEN}：低风险读取，自动执行，无需确认。`,
    `- ${RISK_LABEL.YELLOW}：中风险操作，必须经用户确认后才会执行。`,
    `- ${RISK_LABEL.RED}：高风险操作，必须经用户输入验证码验证后才会执行。`,
    '',
    '## 可用工具（仅限以下，绝不臆造其它能力）',
    renderToolList(ctx.toolNames),
    '',
    '## 事实来源',
    `业务时钟：${new Date(demoNow() + 8 * 3600000).toISOString().slice(0, 19)}，时区 Asia/Shanghai。`,
    '工具结果包含服务端结构化结果和内部 id。操作前先查询；请用对应对象的 id，不要把卡号掩码或产品代码猜成内部 id。唯一名称、卡片尾号和产品代码也可由服务端解析。',
    '定时任务优先使用 runAtLocal（YYYY-MM-DDTHH:mm，北京时间），保留用户明确的年份和时刻，不要自行猜算 epoch。此 demo 只记录任务，不保证到期执行。',
    '条件计划使用 {path,op,value}，消费分析输出字段为 total，余额输出字段为 totalAvailable。例如 {path:"n1.total",op:">",value:2000}。依赖节点必须先成功。',
    '用户已明确提出冻结卡片、设置订阅提醒等操作时，查询匹配对象后调用相应工具生成确认卡，不要因需要确认而停在口头建议。',
    'change_password 只演示强验证，请用空参数调用；禁止要求用户在聊天里提供当前密码、新密码或真实凭证。',
    HALLUCINATION_RULE,
    '任何金额、余额、交易、产品或持仓等金融事实，都必须来自工具返回结果。',
    '若工具返回 success:false 或 ok:false，必须如实报告失败及其原因，绝不编造成功、绝不虚构数据。',
    '',
    '## 输出要求',
    '- 绝不输出内部思考过程（chain-of-thought）；只展示任务步骤、工具调用状态与工具返回的结果。',
    '- 金额使用人民币符号 ¥ 并保留两位小数（例如 ¥1,234.56）。',
    '- 使用与用户一致的语言（默认中文），回答简洁、专业、有条理。',
  ].join('\n');
}
