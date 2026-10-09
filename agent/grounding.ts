/**
 * grounding.ts — SERVER-SIDE FACT GROUNDING for the assistant's final natural-language text.
 *
 * The model's prose is RAW output. This module is the code-enforced HALLUCINATION GUARD that the
 * prompt rule (`./system-prompt.ts#HALLUCINATION_RULE`) can only *ask* the model to respect: it
 * compares the final assistant text against the AUTHORITATIVE server facts collected from the turn's
 * REAL tool results and REPLACES an inconsistent message with a server-authored correction. It never
 * appends contradictory text, never invents a fact, and never decides permission — the model still
 * decides WHAT to do, code decides WHETHER it is allowed (root invariant).
 *
 * PURE: no DB access, no pi imports (only `@/lib/money`, plus a TYPE-ONLY tools import that is erased
 * at compile time). `buildFinancialFacts` extracts the authoritative numbers from real results;
 * `groundAssistantText` is the decision. Both are wired into `./run-turn` at the assistant
 * `message_end` chokepoint (+ a pre-persist safety net) so the FINAL UI text is the grounded one.
 */
import { formatCNY, parseAmount } from '@/lib/money';
import type { ToolExecutionResult } from './tools';

/**
 * The gated/state-changing tools whose SUCCESS changes money or product state. A claim of completion
 * about one of these is only grounded when a write actually succeeded (see `anyWriteSucceeded`).
 */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'transfer_money',
  'reserve_budget',
  'set_card_limit',
  'cancel_subscription',
  'freeze_card',
  'apply_virtual_card',
  'set_subscription_reminder',
  'create_scheduled_task',
  'subscribe_investment',
  'redeem_investment',
  'report_lost_card',
  'unfreeze_card',
  'change_password',
]);

/** Authoritative financial facts distilled from the turn's REAL tool results. */
export interface FinancialFacts {
  /** Every authoritative account balance seen this turn (from `get_balance`). */
  balances: number[];
  /** The authoritative available total (from `get_balance.totalAvailable`), when present. */
  totalBalance?: number;
  /** One entry per side-effecting tool result the turn produced. */
  writes: Array<{ toolName: string; ok: boolean; summary?: string }>;
  /** True iff at least one side-effecting write actually succeeded. */
  anyWriteSucceeded: boolean;
  /** True iff the turn produced any tool result at all. */
  hasToolResults: boolean;
}

/** The server tag marking a text the server already corrected (also makes grounding idempotent). */
const CORRECTION_TAG = '（系统校正）';

/** Server-authored replacement for a claimed-but-ungrounded success. */
const FALSE_SUCCESS_STATEMENT =
  `${CORRECTION_TAG}未检测到任何已成功执行的操作：资金未发生变动，账户余额保持不变。请以系统卡片中的实际数据为准。`;

/**
 * Chinese verbs that describe a STATE-CHANGING (money/product) operation. Combined with a completion
 * marker they signal a completion claim about a side effect (see `claimsUngroundedSuccess`).
 */
const WRITE_VERBS: readonly string[] = [
  '转账',
  '转出',
  '转入',
  '汇款',
  '冻结',
  '解冻',
  '取消',
  '预约',
  '申购',
  '赎回',
  '限额',
  '扣款',
  '支付',
  '购买',
  '修改密码',
  '设置',
  '提醒',
  '还款',
  '预留',
];

/** Markers that assert an operation is DONE. */
const COMPLETION_MARKERS: readonly string[] = [
  '已成功',
  '成功',
  '已完成',
  '已执行',
  '完成',
  '已办理',
  '已处理',
  '已生效',
  '已到账',
];

/**
 * Phrases that mark a NON-completion — an explicit failure, a pending/awaiting state, a future/intent
 * statement, or a read-only report. Grounding must NOT fire on any of these (conservative by design:
 * a missed correction is far less harmful than replacing a correct message).
 */
const NON_COMPLETION: readonly string[] = [
  '失败',
  '不足',
  '无法',
  '未能',
  '未成功',
  '未完成',
  '尚未',
  '未执行',
  '未被',
  '未通过',
  '未发生',
  '等待',
  '待',
  '需要',
  '将',
  '抱歉',
];

/** Balance-labeled keywords; an amount adjacent to one is treated as a CLAIMED balance. */
const BALANCE_KEYWORDS: readonly string[] = [
  '可用余额',
  '余额合计',
  '账户余额',
  '可用总额',
  '账户总额',
  '余额',
];

/** Absolute tolerance (¥) for matching a claimed amount against an authoritative one. */
const MONEY_TOLERANCE = 0.01;

/** Extract every `get_balance` balance + total from the turn's REAL results. */
export function buildFinancialFacts(
  results: ReadonlyArray<{ toolName: string; result: ToolExecutionResult }>,
): FinancialFacts {
  const balances: number[] = [];
  let totalBalance: number | undefined;
  const writes: Array<{ toolName: string; ok: boolean; summary?: string }> = [];

  for (const { toolName, result } of results) {
    if (toolName === 'get_balance') {
      const data = result.data;
      if (isRecord(data)) {
        if (isFiniteNumber(data.totalAvailable)) totalBalance = data.totalAvailable;
        if (Array.isArray(data.accounts)) {
          for (const account of data.accounts) {
            if (isRecord(account) && isFiniteNumber(account.balance)) balances.push(account.balance);
          }
        }
      }
    }
    if (SIDE_EFFECT_TOOLS.has(toolName)) {
      writes.push({
        toolName,
        ok: result.ok === true,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
      });
    }
  }

  return {
    balances,
    ...(totalBalance !== undefined ? { totalBalance } : {}),
    writes,
    anyWriteSucceeded: writes.some((write) => write.ok),
    hasToolResults: results.length > 0,
  };
}

/**
 * Ground the assistant's final text against the authoritative facts. Returns `text` UNCHANGED when it
 * is consistent; otherwise a SERVER-authored Chinese replacement (never an appended contradiction).
 * The two rules COMPOSE (a false success AND a wrong balance ⇒ both corrections).
 */
export function groundAssistantText(text: string, facts: FinancialFacts): string {
  if (text.trim() === '') return text;
  // Idempotent: a text the server already corrected is never re-examined.
  if (text.includes(CORRECTION_TAG)) return text;

  const statements: string[] = [];
  if (claimsUngroundedSuccess(text, facts)) statements.push(FALSE_SUCCESS_STATEMENT);
  if (claimsWrongBalance(text, facts)) statements.push(balanceCorrection(facts));
  return statements.length === 0 ? text : statements.join(' ');
}

/* ------------------------------------------------------------------------------- rule internals */

/**
 * FALSE-SUCCESS rule: the text claims a state-changing operation is DONE, but NO write actually
 * succeeded this turn. Requires BOTH a write verb AND a completion marker, and is suppressed by any
 * failure / pending / future phrasing (so honest failure and "awaiting confirmation" narration — and
 * read-only reports — are never rewritten).
 */
function claimsUngroundedSuccess(text: string, facts: FinancialFacts): boolean {
  if (facts.anyWriteSucceeded) return false;
  if (NON_COMPLETION.some((phrase) => text.includes(phrase))) return false;
  const hasWriteVerb = WRITE_VERBS.some((verb) => text.includes(verb));
  const hasCompletion = COMPLETION_MARKERS.some((marker) => text.includes(marker));
  return hasWriteVerb && hasCompletion;
}

/**
 * BALANCE-CONTRADICTION rule: the text states a balance-labeled amount that matches NO authoritative
 * amount. Conservative — an empty authority set (no `get_balance` this turn) can never contradict.
 */
function claimsWrongBalance(text: string, facts: FinancialFacts): boolean {
  const authoritative = authoritativeAmounts(facts);
  if (authoritative.length === 0) return false;
  const claimed = claimedBalanceAmounts(text);
  if (claimed.length === 0) return false;
  return claimed.some(
    (amount) => !authoritative.some((actual) => Math.abs(actual - amount) <= MONEY_TOLERANCE),
  );
}

/** The authoritative amounts a balance claim may match: every account balance + the available total. */
function authoritativeAmounts(facts: FinancialFacts): number[] {
  return facts.totalBalance !== undefined
    ? [...facts.balances, facts.totalBalance]
    : [...facts.balances];
}

/**
 * Extract every amount the text presents as a BALANCE (an amount within a short window after a
 * balance keyword). Anchoring on the keyword keeps ordinary transfer/spend amounts from being
 * mistaken for a balance claim.
 */
function claimedBalanceAmounts(text: string): number[] {
  const keyword = BALANCE_KEYWORDS.join('|');
  const re = new RegExp(
    `(?:${keyword})[^。；;，,\\n]{0,16}?(?:¥|￥)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`,
    'g',
  );
  const amounts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = parseAmount(match[1]);
    if (Number.isFinite(value)) amounts.push(value);
  }
  return amounts;
}

/** Build the server-authored balance statement from the authoritative total. */
function balanceCorrection(facts: FinancialFacts): string {
  const total = facts.totalBalance ?? Math.max(...facts.balances);
  return `${CORRECTION_TAG}你的账户可用余额合计为 ${formatCNY(total)}。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
