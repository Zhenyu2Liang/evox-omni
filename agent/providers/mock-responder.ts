/**
 * mock-responder — the deterministic "brain" of the offline mock model.
 *
 * `respond(context)` inspects the conversation and returns the next assistant message as a
 * pure function of that conversation. It is the scripted replacement for a live LLM: the same
 * Agent / tools / security pipeline runs unchanged — only the model is scripted.
 *
 * PURITY CONTRACT:
 *  - No Prisma / banking-sdk / network / filesystem access.
 *  - No `Date.now()` / `Math.random()` that could change the CONTENT of a reply. Tool-call ids
 *    are EXPLICIT and stable (e.g. `call_get_balance`) so a run is byte-for-byte reproducible.
 *  - Only `@earendil-works/pi-ai` (faux helpers + message types) is imported.
 *
 * The decision state machine:
 *  1. If a tool just ran (the most recent `toolResult` follows the most recent user message),
 *     NARRATE its outcome — and, when the tool was `search_contact` for a transfer request,
 *     REFINE the recipient into a `transfer_money` call instead.
 *  2. Otherwise classify the latest user message by fuzzy Chinese keywords and emit the tool
 *     call(s), clarifying when required information is missing.
 *
 * It NEVER decides whether an action is ALLOWED — gated (YELLOW/RED) calls are still blocked by
 * the security gateway; a block simply surfaces back as a `toolResult` and is narrated as
 * "awaiting confirmation / verification, not executed".
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type {
  AssistantMessage,
  JsonObject,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { parseBankingGuidance, type BankingGuidance } from '../banking-guidance';

/** Minimal structural view of the pi-ai `Context` this responder needs (a `Context` is assignable to it). */
export interface MockContext {
  systemPrompt?: string;
  messages: Message[];
  tools?: unknown[];
}

/** The exact literal the security gateway prefixes onto an opaque block reason. */
const BLOCK_PREFIX = '__SECURITY_BLOCK__';

const HELP_TEXT =
  '你好，我是你的银行智能助手。你可以让我查询余额、交易明细、消费分析、卡片、订阅、理财和定时任务，' +
  '也可以发起转账等操作（其中中等及高风险操作需要你确认或通过验证码验证后才会执行）。请问需要我做什么？';

/* ============================================================ public entry */

/** The scripted decision function: conversation in, next assistant message out. PURE. */
export function respond(context: MockContext): AssistantMessage {
  const messages = context.messages ?? [];
  const lastUserIndex = findLastUserIndex(messages);
  const lastUser =
    lastUserIndex >= 0 ? contentToText((messages[lastUserIndex] as UserMessage).content).trim() : '';
  const lastToolResult = lastToolResultAfter(messages, lastUserIndex);

  if (lastToolResult) {
    const sourceCall = findToolCall(messages, lastToolResult.toolCallId);
    if (sourceCall?.name === 'search_contact' && isTransferIntent(lastUser)) {
      return refineTransfer(lastUser, lastToolResult);
    }
    return narrate(lastToolResult);
  }

  return classify(lastUser, messages);
}

/** Banking runtime negotiates structured guidance; the plain responder stays compatible for callers. */
export function respondWithGuidance(context: MockContext): AssistantMessage {
  const reply = respond(context);
  if (reply.content.some(part => part.type === 'toolCall') || parseBankingGuidance(contentToText(reply.content))) return reply;
  const messages = context.messages ?? [];
  const index = findLastUserIndex(messages);
  const text = index < 0 ? '' : contentToText((messages[index] as UserMessage).content);
  const lastResult = lastToolResultAfter(messages, index);
  const guidance = (value: BankingGuidance) => plain(JSON.stringify({ guidance: value }));
  if (isTransferIntent(text)) {
    const intent = parseTransfer(text);
    const fields: ('recipient' | 'amount')[] = [];
    if ((!intent.recipient && !intent.reuseRecipient) || (intent.reuseRecipient && !priorTransferRecipient(messages))) fields.push('recipient');
    if (intent.amount == null) fields.push('amount');
    if (fields.length) return guidance({ code: 'missing_details', fields });
    if (lastResult?.toolName === 'search_contact') return guidance({ code: 'ambiguous_selection', fields: ['recipient'] });
  }
  // A settled banking result is narrated from real facts, never turned into a missing-field claim.
  if (lastResult) return reply;
  if (/(申购|认购|买入|购买)/.test(text) || /买[^\n]{0,6}(理财|基金|产品)/.test(text)) {
    if (!extractProductName(text)) return guidance({ code: 'missing_details', fields: ['product'] });
    if (parseAmount(text) == null) return guidance({ code: 'missing_details', fields: ['amount'] });
  }
  return reply;
}

/* ============================================================ narration */

function narrate(result: ToolResultMessage): AssistantMessage {
  const raw = contentToText(result.content).trim();
  const blocked =
    raw.includes(BLOCK_PREFIX) ||
    /等待确认|等待验证|awaiting|需你确认|需进行安全验证|验证码|\bMFA\b/i.test(raw);
  if (blocked) return blockedReply(result.toolName, raw);
  if (result.isError) return failureReply(result.toolName, raw);
  return successReply(result.toolName, raw);
}

/** STEP 5 — a gated YELLOW/RED call parked for a human decision. It has NOT executed. */
function blockedReply(toolName: string, raw: string): AssistantMessage {
  const label = humanTool(toolName);
  if (/require_mfa|验证码|\bMFA\b|等待验证|需进行安全验证/i.test(raw)) {
    return plain(
      `这笔操作（${label}）属于高风险操作，需要你完成安全验证（输入 6 位短信验证码）后才会执行。` +
        '目前状态为「等待验证」，尚未执行。请按提示完成验证。',
    );
  }
  if (/deny|熔断|锁定/i.test(raw)) {
    return plain(
      `当前会话已触发安全熔断，高风险操作已被锁定（${label} 未执行）。请前往安全中心解除限制后再试。`,
    );
  }
  return plain(
    `这笔操作（${label}）需要你确认后才会执行，目前状态为「等待确认」，尚未执行。请你确认后我才会为你执行。`,
  );
}

/** STEP 4 — honest failure: never claim success, never invent data. */
function failureReply(toolName: string, raw: string): AssistantMessage {
  const detail = raw || '工具返回了失败，但没有提供更多信息。';
  return plain(`抱歉，${humanTool(toolName)}未能成功完成：${detail}`);
}

/** STEP 4 — success: faithfully relay the tool's own human summary. */
function successReply(toolName: string, raw: string): AssistantMessage {
  const lead = NARRATION_LEAD[toolName] ?? '操作已完成：';
  const body = raw || '操作已完成。';
  return plain(`${lead}${body}`);
}

const NARRATION_LEAD: Record<string, string> = {
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

const TOOL_LABEL: Record<string, string> = {
  get_balance: '余额查询',
  get_transactions: '交易明细查询',
  search_contact: '联系人查询',
  transfer_money: '转账',
  analyze_spending: '消费分析',
  detect_anomaly: '异常检测',
  get_cards: '卡片查询',
  set_card_limit: '额度设置',
  freeze_card: '冻结卡片',
  unfreeze_card: '解冻卡片',
  report_lost_card: '卡片挂失',
  apply_virtual_card: '虚拟卡申请',
  list_subscriptions: '订阅查询',
  cancel_subscription: '取消订阅',
  set_subscription_reminder: '订阅提醒',
  list_investments: '理财产品查询',
  compare_investments: '理财对比',
  get_investment_holdings: '理财持仓查询',
  subscribe_investment: '理财申购',
  redeem_investment: '理财赎回',
  reserve_budget: '预留预算',
  list_scheduled_tasks: '定时任务查询',
  create_scheduled_task: '创建定时任务',
  get_dashboard_summary: '资产概览',
  submit_plan: '任务计划',
};

function humanTool(toolName: string): string {
  return TOOL_LABEL[toolName] ?? toolName;
}

/* ============================================================ classification */

function classify(text: string, messages: Message[]): AssistantMessage {
  const t = text.trim();
  // Script the same closed guidance protocol as live mode; these are mock intent routes, not permissions.
  if (/赎回/.test(t) && /(部分|只赎回\s*\d|只想.*赎回\s*\d|剩下.*持有|不要全额赎回)/.test(t)) {
    return plain(JSON.stringify({ guidance: { code: 'partial_redemption_unsupported' } }));
  }
  if (/(申购|认购|买)/.test(t) && /储蓄账户/.test(t)) {
    return plain(JSON.stringify({ guidance: { code: 'investment_funding_account_unsupported' } }));
  }
  if (/(总授信额度|总额度)/.test(t) && /(调整|提高|修改)/.test(t)) {
    return plain(JSON.stringify({ guidance: { code: 'credit_line_adjustment_unsupported' } }));
  }
  if (/(能做什么|有哪些功能|介绍.*能力)/.test(t)) return plain(JSON.stringify({ guidance: { code: 'capabilities' } }));
  if (t === '' || /^(你好|您好|hi|hello|哈喽|嗨|在吗)[!！。？?~～\s]*$/i.test(t)) {
    return plain(HELP_TEXT);
  }

  if (isTransferIntent(t)) return handleTransfer(t, messages);

  if (/(定时任务|计划任务|提醒任务|任务列表|自动任务)/.test(t)) {
    return toolCall('list_scheduled_tasks', {});
  }
  if (isConditionalPlan(t)) return handlePlan(t);

  // DIRECT ACTION routes (gated YELLOW/RED tools) — matched BEFORE the broad READ matchers below
  // (卡片/订阅/理财/…) so an action request is never answered with a query result instead.
  const action = classifyDirectAction(t, messages);
  if (action) return action;

  if (/(异常|可疑|奇怪|盗刷|被刷|乱扣|乱花|不对的消费)/.test(t)) {
    return toolCall('detect_anomaly', {});
  }
  if (/(流水|明细|记录|账单|交易)/.test(t)) {
    return toolCall('get_transactions', {});
  }
  if (/(花了|花销|开销|消费|支出|花费|花掉)/.test(t)) {
    return toolCall('analyze_spending', {});
  }
  if (/(概览|总资产|资产总览|总览|资产情况|家底)/.test(t)) {
    return toolCall('get_dashboard_summary', {});
  }
  if (/(余额|还剩|存款|活期|有多少钱|多少钱)/.test(t)) {
    return toolCall('get_balance', {});
  }
  if (/(卡片|银行卡|信用卡|哪张卡|额度|卡号)/.test(t)) {
    return toolCall('get_cards', {});
  }
  if (/(订阅|会员|自动续费|续费)/.test(t)) {
    return toolCall('list_subscriptions', {});
  }
  if (/(持仓|持有|我买的)/.test(t)) {
    return toolCall('get_investment_holdings', {});
  }
  if (/(理财|投资|基金|产品)/.test(t)) {
    return toolCall('list_investments', {});
  }
  if (/(预留|预算|攒钱|存钱|专款|存一笔)/.test(t)) {
    return handleBudget(t);
  }
  if (/(联系人|通讯录)/.test(t)) {
    return toolCall('search_contact', { query: extractContactQuery(t) });
  }

  return plain(HELP_TEXT);
}

/** A natural-language condition/automation request that belongs to `submit_plan` (a DAG plan). */
function isConditionalPlan(text: string): boolean {
  return /如果|就提醒|就通知|就告诉我|帮我规划|帮我计划|规划一下|计划一下|帮我安排|自动化|设定条件|超过[^。！？]*就/.test(
    text,
  );
}

/* ------------------------------------------------------------- transfer */

function isTransferIntent(text: string): boolean {
  if (/(转账|转帐|汇款|打钱|转钱|转给|转笔|再转)/.test(text)) return true;
  if (/(给|向|帮).{0,10}(转|打|汇)/.test(text)) return true;
  if (/转\s*[\d零一二三四五六七八九十百千万两]/.test(text)) return true;
  return false;
}

interface TransferIntent {
  recipient?: string;
  amount?: number;
  remark?: string;
  reuseRecipient: boolean;
  explicitReuse: boolean;
}

/**
 * STEP 2/3/3b/3c — parse a transfer request. Recipient resolution STARTS with `search_contact`;
 * the recipient is only turned into a `transfer_money` call once (and only if) it resolves to a
 * single contact (`refineTransfer`).
 */
function handleTransfer(text: string, messages: Message[]): AssistantMessage {
  const intent = parseTransfer(text);

  if (intent.reuseRecipient) {
    const prior = priorTransferRecipient(messages);
    if (!prior) {
      return plain(
        intent.explicitReuse
          ? '我还没有记录到之前的收款人，请告诉我这次要转给谁、转多少钱。'
          : '请问要转给谁？请告诉我收款人和金额，例如“给张伟转200元”。',
      );
    }
    const label = prior.name ?? prior.contactId ?? '对方';
    if (intent.amount == null) {
      return plain(`请问要转给${label}多少钱？`);
    }
    const args: Record<string, unknown> = { ...prior, amount: intent.amount };
    if (intent.remark) args.remark = intent.remark;
    return toolCall('transfer_money', args);
  }

  if (!intent.recipient) {
    return plain('请问要转给谁？请告诉我收款人和金额，例如“给张伟转200元”。');
  }
  if (intent.amount == null) {
    return plain(`请问要给${intent.recipient}转多少钱？`);
  }
  return toolCall('search_contact', { query: intent.recipient });
}

/** STEP 3 — after a `search_contact` result for a transfer request, resolve the recipient. */
function refineTransfer(text: string, result: ToolResultMessage): AssistantMessage {
  const intent = parseTransfer(text);
  const contacts = parseContacts(result);

  if (contacts.length === 0) {
    const who = intent.recipient ?? '该联系人';
    return plain(`没有找到“${who}”这位联系人，请确认姓名后再说一次。`);
  }
  if (contacts.length > 1) {
    const names = contacts.map((c) => c.name).join('、');
    return plain(`我找到 ${contacts.length} 位匹配的联系人：${names}。请确认要转给哪一位？`);
  }

  const one = contacts[0];
  if (intent.amount == null) {
    return plain(`请问要给${one.name}转多少钱？`);
  }
  const args: Record<string, unknown> = {};
  if (one.id) args.contactId = one.id;
  else args.name = one.name;
  args.amount = intent.amount;
  if (intent.remark) args.remark = intent.remark;
  return toolCall('transfer_money', args);
}

function parseTransfer(text: string): TransferIntent {
  const remarkMatch = text.match(/备注[:：]?\s*(.+)$/);
  const remark = remarkMatch?.[1]?.trim() || undefined;
  const withoutRemark = remarkMatch ? text.slice(0, remarkMatch.index) : text;

  const amount = parseAmount(withoutRemark);
  const rawRecipient = extractRecipient(withoutRemark);

  let recipient: string | undefined = rawRecipient;
  let reuseRecipient = false;
  if (!rawRecipient) {
    reuseRecipient = true;
  } else if (isReuseName(rawRecipient)) {
    recipient = undefined;
    reuseRecipient = true;
  }

  const explicitReuse = /(刚才|那个|那位|那个人|他|她|同上|之前|上次|同一个|再转|还是)/.test(text);
  return { recipient, amount, remark, reuseRecipient, explicitReuse };
}

function extractRecipient(text: string): string | undefined {
  const patterns = [
    /(?:转给|转账给|转帐给|给|向|帮)\s*([\u4e00-\u9fa5A-Za-z·]{1,20}?)(?:转|汇|打|转账)/,
    /(?:转给|转账给|转帐给)\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/,
    /(?:给|向)\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/,
  ];
  for (const re of patterns) {
    const candidate = text.match(re)?.[1]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

function isReuseName(name: string): boolean {
  return /(刚才|那个|那位|那个人|他|她|此人|同上|之前的|上次的|同一个)/.test(name);
}

/** STEP 3b — the recipient reused from the most recent transfer (or single-match contact search). */
function priorTransferRecipient(
  messages: Message[],
): { contactId?: string; name?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type === 'toolCall' && block.name === 'transfer_money') {
        const args = (block.arguments ?? {}) as Record<string, unknown>;
        const contactId = typeof args.contactId === 'string' ? args.contactId : undefined;
        const name = typeof args.name === 'string' ? args.name : undefined;
        if (contactId || name) return { contactId, name };
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'toolResult' && msg.toolName === 'search_contact') {
      const contacts = parseContacts(msg);
      if (contacts.length === 1) return { contactId: contacts[0].id, name: contacts[0].name };
    }
  }
  return null;
}

interface ContactMatch {
  id?: string;
  name: string;
}

/** Prefer the tool result's structured `details` (ContactView[]); fall back to parsing its text. */
function parseContacts(result: ToolResultMessage): ContactMatch[] {
  const details = result.details;
  if (Array.isArray(details)) {
    const list: ContactMatch[] = [];
    for (const item of details) {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        const rec = item as { id?: unknown; name: string };
        list.push({ id: typeof rec.id === 'string' ? rec.id : undefined, name: rec.name });
      }
    }
    if (list.length > 0 || details.length === 0) return list;
  }
  return parseContactsFromText(contentToText(result.content));
}

function parseContactsFromText(text: string): ContactMatch[] {
  if (/未找到/.test(text)) return [];
  const countMatch = text.match(/找到\s*(\d+)\s*位/);
  if (!countMatch) return [];
  const count = Number(countMatch[1]);
  if (!Number.isFinite(count) || count <= 0) return [];

  const colon = text.indexOf('：');
  const body = colon >= 0 ? text.slice(colon + 1) : text;
  return body
    .split(/[、，,]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '' && !seg.startsWith('另有'))
    .map((seg) => seg.replace(/[（(].*$/, '').trim())
    .filter((name) => name !== '')
    .map((name) => ({ name }));
}

/* ------------------------------------------------------------- budget */

function handleBudget(text: string): AssistantMessage {
  const amount = parseAmount(text);
  if (amount == null) {
    return plain('请问要预留多少钱？例如“帮我预留2000元买手机”。');
  }
  const purpose = deriveBudgetPurpose(text);
  const name = purpose ?? '预算预留';
  const args: Record<string, unknown> = { name, amount };
  if (purpose) args.purpose = purpose;
  return toolCall('reserve_budget', args);
}

function deriveBudgetPurpose(text: string): string | undefined {
  const purpose = text
    .replace(/[\d零一二三四五六七八九十百千万两]+\s*(?:元|块钱|块|人民币)?/g, '')
    .replace(
      /(帮我|请|我想|我要|麻烦|给我|先|预留|留出|留|预算|攒钱|存钱|攒|存|一笔|专款|用于|用来|为了|块钱|的|元|块)/g,
      '',
    )
    .replace(/[，,。.、！!？?~～\s]+/g, '')
    .trim();
  return purpose === '' ? undefined : purpose;
}

/* ------------------------------------------------------------- plan */

interface PlanCondition {
  path: string;
  op: '>' | '>=' | '<' | '<=' | '==' | '!=';
  value: number | string | boolean;
}

interface PlanNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
  condition?: PlanCondition;
}

function handlePlan(text: string): AssistantMessage {
  const threshold = parseThreshold(text);
  const limitAdjustment = parseCardLimitAdjustment(text);
  const nodes: PlanNode[] = [];

  if (limitAdjustment !== undefined) {
    // Conditional LIMIT-ADJUSTMENT plan: a GREEN analysis node, a condition on its total, then a
    // GATED `set_card_limit` node (YELLOW — it never executes here; the gateway blocks it and the
    // plan node PARKS in `waiting_confirmation` until the user confirms).
    nodes.push({
      id: 'analyze',
      name: '查询消费情况',
      dependencies: [],
      kind: 'tool',
      tool: 'analyze_spending',
      args: {},
    });
    nodes.push({
      id: 'check',
      name: '判断是否超过阈值',
      dependencies: ['analyze'],
      kind: 'condition',
      condition: { path: 'analyze.total', op: '>', value: threshold ?? PLAN_DEFAULT_THRESHOLD },
    });
    nodes.push({
      id: 'setlimit',
      name: `调整「${limitAdjustment.category}」消费限额`,
      dependencies: ['check'],
      kind: 'tool',
      tool: 'set_card_limit',
      args: {
        cardId: DEMO_CREDIT_CARD_ID,
        category: limitAdjustment.category,
        amount: limitAdjustment.amount,
      },
    });
  } else if (/(消费|花|支出)/.test(text)) {
    nodes.push({
      id: 'analyze',
      name: '查询消费情况',
      dependencies: [],
      kind: 'tool',
      tool: 'analyze_spending',
      args: {},
    });
    if (threshold != null) {
      nodes.push({
        id: 'check',
        name: '判断是否超过阈值',
        dependencies: ['analyze'],
        kind: 'condition',
        condition: { path: 'analyze.total', op: '>', value: threshold },
      });
      nodes.push({
        id: 'remind',
        name: '发送提醒',
        dependencies: ['check'],
        kind: 'note',
      });
    } else {
      nodes.push({
        id: 'summarize',
        name: '汇总结果',
        dependencies: ['analyze'],
        kind: 'note',
      });
    }
  } else if (/余额/.test(text)) {
    nodes.push({
      id: 'balance',
      name: '查询账户余额',
      dependencies: [],
      kind: 'tool',
      tool: 'get_balance',
      args: {},
    });
    nodes.push({
      id: 'summarize',
      name: '汇总结果',
      dependencies: ['balance'],
      kind: 'note',
    });
  } else {
    nodes.push({ id: 'note', name: '执行计划', dependencies: [], kind: 'note' });
  }

  return toolCall('submit_plan', { goal: text, nodes });
}

function parseThreshold(text: string): number | undefined {
  const m = text.match(/(?:超过|大于|高于|多于|超出|>=?|＞)\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

/** Spend threshold a conditional plan defaults to when it names no explicit 超过/大于 number. */
const PLAN_DEFAULT_THRESHOLD = 2000;

/**
 * Seeded credit-card id a scripted limit-adjustment plan targets. It is a DEMO-MODEL scripted id:
 * `mock-responder.ts` holds no DB access (purity contract — no prisma / banking-sdk imports), so it
 * cannot look a card up and instead references the deterministic seeded `card_credit`
 * (see `prisma/seed.ts` / `tests/helpers/fixtures.ts`; it already carries an 娱乐 limit).
 */
const DEMO_CREDIT_CARD_ID = 'card_credit';

/** Card spend categories a limit-adjustment plan can target (the SDK accepts a free-form category). */
const CARD_LIMIT_CATEGORIES = ['娱乐', '餐饮', '购物', '出行', '生活', '居家', '教育', '医疗', '通讯', '其他'];

/** Sensible default category when the request names none (matches the seeded 娱乐 card limit). */
const DEFAULT_CARD_LIMIT_CATEGORY = '娱乐';

/**
 * The adjustment verbs that introduce a NEW card limit. `调整到` (调-整-到) is included because the
 * very common phrase "…调整到1500" (no 元/¥ suffix) would otherwise be missed. Shared by the direct
 * `set_card_limit` route AND the conditional-plan limit branch so the two never diverge.
 */
const LIMIT_ADJUSTMENT_VERB =
  '调整到|调整为|调整成|调整至|调到|调成|改成|改为|设置为|设为|限额为|设定为|限定为|限制为';

/**
 * Whether the text carries a limit-ADJUSTMENT intent even when the amount is still missing (the bare
 * `调整` covers "…调整一下" / "…调整" with no number yet). Distinct from the amount pattern above,
 * which needs the precise verb+number shape.
 */
const LIMIT_ADJUSTMENT_INTENT_RE = /(调整|改成|改为|设置为|设为|调到|调成|限额为|设定为|限定为|限制为)/;

/** The limit amount that follows the adjustment verb — the one AFTER the verb, never an earlier number. */
const LIMIT_ADJUSTMENT_AMOUNT_RE = new RegExp(`(?:${LIMIT_ADJUSTMENT_VERB})\\s*(\\d+(?:\\.\\d+)?)`);

interface CardLimitAdjustment {
  category: string;
  amount: number;
}

/**
 * A card spend-limit ADJUSTMENT phrased inside a conditional plan, e.g.
 * "…就把娱乐消费限额调整为1500元" ⇒ `{ category: '娱乐', amount: 1500 }`.
 *
 * Returns `undefined` unless BOTH a 限额/额度 noun AND an adjustment verb (调整为/改为/…) are present.
 * The adjustment amount is the one AFTER the verb — `parseAmount` would wrongly grab the earlier
 * threshold number, so it is parsed here with a dedicated pattern.
 */
function parseCardLimitAdjustment(text: string): CardLimitAdjustment | undefined {
  if (!/(限额|额度)/.test(text)) return undefined;
  const m = text.match(LIMIT_ADJUSTMENT_AMOUNT_RE);
  if (!m) return undefined;
  const category =
    CARD_LIMIT_CATEGORIES.find((candidate) => text.includes(candidate)) ?? DEFAULT_CARD_LIMIT_CATEGORY;
  return { category, amount: Number(m[1]) };
}

/* ------------------------------------------------------------- direct actions */

/**
 * DIRECT ACTION routes: a request that targets a gated (🟡 YELLOW / 🔴 RED) banking tool. `classify`
 * consults them BEFORE the broad READ matchers (卡片/订阅/理财/…) so an action is never answered with
 * a query result instead. Each returns a SINGLE tool call — or, when required information is missing,
 * a plain CLARIFICATION asking for exactly that field — or `undefined` when the text is not that
 * action (so classification falls through to the READ matchers).
 *
 * Purity contract: a scripted DEMO id map stands in for a DB lookup (no prisma / banking-sdk here).
 * These routes only decide WHAT to do next — never WHETHER it is allowed: every emitted tool still
 * passes through the single security chokepoint (`beforeToolCall → security.gateway`).
 */
function classifyDirectAction(text: string, messages: Message[]): AssistantMessage | undefined {
  return (
    classifySetCardLimit(text) ??
    classifyFreezeCard(text) ??
    classifySubscribeInvestment(text) ??
    classifyRedeemInvestment(text) ??
    classifyCancelSubscription(text) ??
    classifyActionFollowUp(text, messages)
  );
}

/** A clarification asking for the (missing) adjusted limit amount. */
const LIMIT_AMOUNT_QUESTION = '请问要把限额调整到多少？例如“把娱乐限额调整到1500”。';

/** 🟡 `set_card_limit` — a spend-limit adjustment, e.g. "把信用卡娱乐限额调整到1500". */
function classifySetCardLimit(text: string): AssistantMessage | undefined {
  if (!/(限额|额度)/.test(text)) return undefined;
  if (!LIMIT_ADJUSTMENT_INTENT_RE.test(text)) return undefined;
  const amount = parseLimitAdjustmentAmount(text);
  if (amount == null) return plain(LIMIT_AMOUNT_QUESTION);
  const category =
    CARD_LIMIT_CATEGORIES.find((candidate) => text.includes(candidate)) ?? DEFAULT_CARD_LIMIT_CATEGORY;
  return toolCall('set_card_limit', { cardId: resolveCardId(text), category, amount });
}

/** The amount AFTER the adjustment verb (dedicated pattern), else `parseAmount` as a fallback. */
function parseLimitAdjustmentAmount(text: string): number | undefined {
  const m = text.match(LIMIT_ADJUSTMENT_AMOUNT_RE);
  if (m) return Number(m[1]);
  return parseAmount(text);
}

/** 🟡 `freeze_card` — e.g. "冻结我的信用卡". An inquiry about a frozen card is not a freeze request. */
function classifyFreezeCard(text: string): AssistantMessage | undefined {
  if (!/冻结/.test(text)) return undefined;
  if (/被冻结|已冻结/.test(text)) return undefined;
  if (!/卡/.test(text)) return plain('请问要冻结哪张卡？例如“冻结我的信用卡”。');
  return toolCall('freeze_card', { cardId: resolveCardId(text) });
}

/** Resolve a scripted demo card id from card words (purity ⇒ no DB lookup). */
function resolveCardId(text: string): string {
  if (/借记卡|储蓄卡/.test(text)) return 'card_debit';
  return DEMO_CREDIT_CARD_ID; // 信用卡 (or unspecified) ⇒ the seeded credit card
}

/**
 * Product NAMES → seeded ids (mirror `tests/helpers/fixtures.ts` PRODUCTS). The responder holds no DB
 * access (purity contract), so a KNOWN name maps to its scripted id and an unknown name is used
 * verbatim as the `productId` (best effort — the SDK then reports an honest failure).
 */
const PRODUCT_ID_BY_NAME: Record<string, string> = {
  稳健理财A: 'prod_wenjiana',
  稳健理财B: 'prod_wenjib',
  进取混合C: 'prod_jinrong',
  货币基金: 'prod_huobi',
};

/** Subscription names → canonical demo seed ids (fixtures cover the original four). */
const SUBSCRIPTION_ID_BY_NAME: Record<string, string> = {
  Netflix: 'sub_netflix',
  Spotify: 'sub_spotify',
  iCloud: 'sub_icloud',
  视频会员: 'sub_video',
  健身会员: 'sub_fitness',
  云盘会员: 'sub_cloud',
};

/** Default holding for an unspecified redemption; named products use their own seeded holding. */
const DEMO_HOLDING_ID = 'holding_wenjiana';
const HOLDING_ID_BY_NAME: Record<string, string> = {
  稳健理财A: DEMO_HOLDING_ID,
  稳健理财B: 'holding_wenjib',
  货币基金: 'holding_huobi',
};

/** 🔴 `subscribe_investment` — e.g. "申购稳健理财A 1000元". */
function classifySubscribeInvestment(text: string): AssistantMessage | undefined {
  if (!/(申购|认购|买入|购买)/.test(text) && !/买[^\n]{0,6}(理财|基金|产品)/.test(text)) {
    return undefined;
  }
  const productName = extractProductName(text);
  if (!productName) {
    return plain('请问要申购哪只理财产品？例如“申购稳健理财A 1000元”。');
  }
  const amount = parseAmount(text);
  if (amount == null) return plain(`请问要申购「${productName}」多少钱？`);
  return toolCall('subscribe_investment', { productId: resolveProductId(productName), amount });
}

/** The product name in the text: a known name first (longest match), else the name after the verb. */
function extractProductName(text: string): string | undefined {
  const known = knownNameInText(text, PRODUCT_ID_BY_NAME);
  if (known) return known;
  const m = text.match(
    /(?:申购|认购|买入|购买|买)\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?=\s*\d|\s*(?:元|块钱|块|人民币|¥|￥)|\s*[，,。！!？?]|\s*$)/,
  );
  const candidate = m?.[1]?.trim().replace(/^[点些个几]{1,3}/, '');
  return candidate ? candidate : undefined;
}

function resolveProductId(name: string): string {
  return PRODUCT_ID_BY_NAME[name] ?? name;
}

/** 🔴 `redeem_investment` — e.g. "赎回稳健理财A"; resolve named demo holdings before the default. */
function classifyRedeemInvestment(text: string): AssistantMessage | undefined {
  const redeem = /赎回/.test(text) || (/取出/.test(text) && /(理财|基金|产品)/.test(text));
  if (!redeem) return undefined;
  const name = knownNameInText(text, HOLDING_ID_BY_NAME);
  return toolCall('redeem_investment', { holdingId: name ? HOLDING_ID_BY_NAME[name] : DEMO_HOLDING_ID });
}

/** 🟡 `cancel_subscription` — e.g. "取消Netflix订阅" / "取消订阅Netflix". */
function classifyCancelSubscription(text: string): AssistantMessage | undefined {
  if (!/(取消|退订)/.test(text)) return undefined;
  if (!/(订阅|会员|续费)/.test(text) && !knownNameInText(text, SUBSCRIPTION_ID_BY_NAME)) {
    return undefined; // not a subscription cancel (e.g. "取消订单") ⇒ fall through
  }
  const name = subscriptionNameInText(text);
  if (!name) return plain('请问要取消哪个订阅？例如“取消Netflix订阅”。');
  return toolCall('cancel_subscription', { subscriptionId: resolveSubscriptionId(name) });
}

/** The subscription name in the text: a known name first, then "取消X订阅" / "取消订阅X". */
function subscriptionNameInText(text: string): string | undefined {
  const known = knownNameInText(text, SUBSCRIPTION_ID_BY_NAME);
  if (known) return known;
  const candidate =
    text.match(/取消\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)\s*订阅/)?.[1]?.trim() ??
    text.match(/取消\s*订阅\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,20})/)?.[1]?.trim();
  // A generic reference ("我的订阅" / "这个订阅") names no subscription ⇒ treat as missing.
  if (!candidate || /的|我的|这个|那个|哪个|哪些|所有|全部/.test(candidate)) return undefined;
  return candidate;
}

function resolveSubscriptionId(name: string): string {
  return SUBSCRIPTION_ID_BY_NAME[name] ?? name;
}

/** The longest KEY of `map` that occurs literally in `text` (undefined when none does). */
function knownNameInText(text: string, map: Record<string, string>): string | undefined {
  let best: string | undefined;
  for (const name of Object.keys(map)) {
    if (text.includes(name) && (best === undefined || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * Cheap multi-turn: a BARE amount answering OUR OWN limit/subscribe clarification reuses the card or
 * product parsed from the message that triggered it (no re-parse of the noun/verb).
 */
function classifyActionFollowUp(text: string, messages: Message[]): AssistantMessage | undefined {
  const amount = parseAmountOnly(text);
  if (amount == null) return undefined;
  const lastUserIndex = findLastUserIndex(messages);
  const priorReply = assistantTextBefore(messages, lastUserIndex);
  if (!priorReply) return undefined;
  const priorUser = userTextBefore(messages, lastUserIndex);

  if (priorReply.includes('要把限额调整到多少') && priorUser) {
    const category =
      CARD_LIMIT_CATEGORIES.find((candidate) => priorUser.includes(candidate)) ??
      DEFAULT_CARD_LIMIT_CATEGORY;
    return toolCall('set_card_limit', { cardId: resolveCardId(priorUser), category, amount });
  }
  if ((/要申购.*多少钱/.test(priorReply) || (priorReply.includes('请补充金额') && /(申购|认购|购买)/.test(priorUser ?? ''))) && priorUser) {
    const productName = extractProductName(priorUser);
    if (productName) {
      return toolCall('subscribe_investment', { productId: resolveProductId(productName), amount });
    }
  }
  return undefined;
}

/** The whole message is just an amount (a bare answer to a clarification), e.g. "1500" / "1500元". */
function parseAmountOnly(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+(?:\.\d+)?\s*(?:元|块钱|块|人民币)?\s*[。.!！]?$/.test(t)) return undefined;
  return parseAmount(t);
}

/** Text of the assistant reply immediately preceding the latest user turn (undefined if none). */
function assistantTextBefore(messages: Message[], lastUserIndex: number): string | undefined {
  for (let i = lastUserIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') return contentToText(msg.content).trim();
    if (msg.role === 'user') return undefined;
  }
  return undefined;
}

/** Text of the user message preceding the latest user turn (undefined if none). */
function userTextBefore(messages: Message[], lastUserIndex: number): string | undefined {
  for (let i = lastUserIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return contentToText((messages[i] as UserMessage).content).trim();
    }
  }
  return undefined;
}

/* ------------------------------------------------------------- misc helpers */

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage(
    [fauxText(ACTION_TEXT[name] ?? '好的，我来处理一下。'), fauxToolCall(name, JSON.parse(JSON.stringify(args)) as JsonObject, { id: `call_${name}` })],
    { stopReason: 'toolUse' },
  );
}

/** A clarifying message: a plain assistant reply with NO tool call. */
function plain(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

const ACTION_TEXT: Record<string, string> = {
  get_balance: '好的，我来查一下你的账户余额。',
  get_transactions: '好的，我来查一下你的交易明细。',
  analyze_spending: '好的，我来分析一下你的消费情况。',
  detect_anomaly: '好的，我来检查一下最近的异常消费。',
  get_cards: '好的，我来查一下你的卡片信息。',
  list_subscriptions: '好的，我来查一下你的订阅情况。',
  list_investments: '好的，我来查一下理财产品。',
  compare_investments: '好的，我来为你对比这些理财产品。',
  get_investment_holdings: '好的，我来查一下你的理财持仓。',
  get_dashboard_summary: '好的，我来为你生成资产概览。',
  list_scheduled_tasks: '好的，我来查一下你的定时任务。',
  search_contact: '好的，我来查找这位联系人。',
  transfer_money: '好的，我来为你处理这笔转账。',
  set_card_limit: '好的，我来为你调整这张卡片的消费限额。',
  freeze_card: '好的，我来为你冻结这张卡片。',
  cancel_subscription: '好的，我来为你取消这个订阅。',
  subscribe_investment: '好的，我来为你办理理财申购。',
  redeem_investment: '好的，我来为你办理理财赎回。',
  reserve_budget: '好的，我来为你预留这笔预算。',
  submit_plan: '好的，我来为你规划一个任务计划。',
};

function extractContactQuery(text: string): string {
  const m = text.match(/(?:联系人|通讯录)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/);
  return m?.[1]?.trim() ?? '';
}

/* ------------------------------------------------------------- amount parsing */

function parseAmount(text: string): number | undefined {
  const arabic = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块钱|块|人民币|rmb|¥|￥)/i);
  if (arabic) return Number(arabic[1]);

  const cn = text.match(/([零一二三四五六七八九十百千万两]+)\s*(?:元|块钱|块|人民币)/);
  if (cn) {
    const value = chineseToNumber(cn[1]);
    if (value != null) return value;
  }

  const afterVerb = text.match(/(?:转|汇|打|给)[^\d零一二三四五六七八九十百千万两]{0,4}?(\d+(?:\.\d+)?)/);
  if (afterVerb) return Number(afterVerb[1]);

  const afterVerbCn = text.match(/(?:转|汇|打)[^\d]{0,4}?([零一二三四五六七八九十百千万两]+)/);
  if (afterVerbCn) {
    const value = chineseToNumber(afterVerbCn[1]);
    if (value != null) return value;
  }

  const anyNumber = text.match(/(\d+(?:\.\d+)?)/);
  return anyNumber ? Number(anyNumber[1]) : undefined;
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** Compact Chinese-numeral parser (handles 五百 / 两千 / 二十五 / 一万 etc.). */
function chineseToNumber(input: string): number | undefined {
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of input) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + current) * unit;
        total += section;
        section = 0;
        current = 0;
      } else {
        section += (current === 0 ? 1 : current) * unit;
        current = 0;
      }
    } else {
      return undefined;
    }
  }
  return total + section + current;
}

/* ------------------------------------------------------------- message helpers */

type TextBlock = { type?: string; text?: string };

function contentToText(content: string | readonly TextBlock[]): string {
  if (typeof content === 'string') return content;
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

function findLastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

function lastToolResultAfter(messages: Message[], afterIndex: number): ToolResultMessage | undefined {
  for (let i = messages.length - 1; i > afterIndex; i--) {
    const msg = messages[i];
    if (msg.role === 'toolResult') return msg;
  }
  return undefined;
}

function findToolCall(messages: Message[], toolCallId: string): { name: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'toolCall' && block.id === toolCallId) return block;
    }
  }
  return undefined;
}
