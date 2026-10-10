/**
 * grounding-facts.ts — STRUCTURED trusted facts + bilingual claim extraction for fact grounding.
 *
 * The model's prose is RAW output. This module turns the turn's REAL tool results into a STRUCTURED,
 * server-owned fact base — accounts (per account, AS-OF a query AND CURRENT after every write), write
 * outcomes (per OPERATION identity: tool + toolCallId/actionId/taskId/nodeId, with amount and
 * recipient), authoritative money amounts — and extracts the CLAIMS a piece of text makes about them
 * (which operation, done/failed/pending, which amount, which recipient, which account).
 *
 * Design: compare STRUCTURE (operation identity, number, entity, account) — never pile up ad-hoc
 * phrases. The word lists below are small, per-category and BILINGUAL (zh + en); they only CLASSIFY a
 * clause, the DECISION is made structurally in `./grounding` against the trusted facts.
 *
 * PURE: no DB access, no pi imports (only a TYPE-ONLY tools import, erased at compile time).
 */
import { parseAmount } from '@/lib/money';
import type { ToolExecutionResult } from './tools';

/**
 * The gated/state-changing tools whose SUCCESS changes money or product state. A completion claim
 * about one of them is only grounded when THAT tool actually succeeded (never another tool's success).
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

/** One authoritative account balance seen this turn (from `get_balance`). */
export interface TrustedAccount {
  id?: string;
  name?: string;
  /** `AccountView.type`: `CHECKING` | `SAVINGS` | … */
  type?: string;
  balance: number;
}

/** The structured recipient of a write (from `TransferResult.recipient`). */
export interface TrustedRecipient {
  name?: string;
  contactId?: string;
  phone?: string;
}

/**
 * A TRUSTED write outcome. `unknown` is a first-class state: the operation's result was neither
 * proven success nor proven failure (e.g. it needs manual reconciliation) and must NEVER be asserted
 * as success, as failure, or as "funds unchanged".
 */
export type TrustedWriteOutcome = 'succeeded' | 'failed' | 'unknown';

/**
 * One authoritative write result, keyed by OPERATION identity — the tool PLUS the server-side call
 * identity (`toolCallId`, plus `actionId`/`taskId`/`nodeId` when the operation parked/ran in a plan).
 * A completion claim is matched to the specific operation it refers to, never to a global
 * "some write of this tool family succeeded". Optional fields are OMITTED when absent.
 */
export interface TrustedWrite {
  toolName: string;
  outcome: TrustedWriteOutcome;
  /** The pi tool-call id of THIS operation (server-generated), when known. */
  toolCallId?: string;
  /** The persisted `PendingAction` id when the operation was gated, when known. */
  actionId?: string;
  /** The owning DAG plan / node when the operation ran as a plan node, when known. */
  taskId?: string;
  nodeId?: string;
  /** The authoritative amount the write moved/reserved (from the SDK DTO), when known. */
  amount?: number;
  /** The authoritative recipient (transfers), when known. */
  recipient?: TrustedRecipient;
  /** The authoritative account balance AFTER the write (from the SDK DTO), when known. */
  balanceAfter?: number;
  /** The account the write debited (server-resolved), when known. */
  accountId?: string;
  /** The tool's server-authored summary text. */
  summary?: string;
  /** The SDK error message for a failed write. */
  error?: string;
}

/** Authoritative financial facts distilled from the turn's REAL tool results. */
export interface FinancialFacts {
  /** Per-account authoritative balances AS-OF the `get_balance` query that reported them. */
  accounts: TrustedAccount[];
  /**
   * Per-account CURRENT balances, applied in RESULT ORDER: a `get_balance` SETS an account balance
   * (a fresh authoritative read) and a SUCCESSFUL write that returns a new balance UPDATES that
   * account. Checking/savings/credit never mix. Used for 「当前余额」 claims.
   */
  currentBalances: TrustedAccount[];
  /** Flat list of every authoritative amount (account balances, dashboard figures, …). */
  balances: number[];
  /** The authoritative available total (from `get_balance.totalAvailable`), when present. */
  totalBalance?: number;
  /** One structured entry per side-effecting tool result the turn produced. */
  writes: TrustedWrite[];
  /** True iff the turn produced any tool result at all. */
  hasToolResults: boolean;
}

/**
 * One tool result as the turn's `factResults` buffer carries it: the tool name, its REAL
 * `ToolExecutionResult`, and the server-side OPERATION identity. The extras are additive/optional so
 * an existing `{ toolName, result }` call still type-checks.
 */
export interface FactInput {
  toolName: string;
  result: ToolExecutionResult;
  toolCallId?: string;
  actionId?: string;
  taskId?: string;
  nodeId?: string;
  /** The account the operation debited (from the tool's server-resolved args), when known. */
  sourceAccountId?: string;
}

/* --------------------------------------------------------------------------- trusted fact build */

/** Extract the structured trusted facts from the turn's REAL results. */
export function buildFinancialFacts(results: ReadonlyArray<FactInput>): FinancialFacts {
  const accounts: TrustedAccount[] = [];
  const balances: number[] = [];
  let totalBalance: number | undefined;
  const writes: TrustedWrite[] = [];

  // The CURRENT-balance ledger, applied in RESULT ORDER. Keyed by account id (else name|type).
  const currentOrder: TrustedAccount[] = [];
  const currentByKey = new Map<string, TrustedAccount>();
  const keyOf = (account: TrustedAccount): string => account.id ?? `${account.name ?? ''}|${account.type ?? ''}`;
  const upsertCurrent = (account: TrustedAccount): TrustedAccount => {
    const key = keyOf(account);
    const existing = currentByKey.get(key);
    if (existing !== undefined) {
      existing.balance = account.balance;
      if (account.id !== undefined) existing.id = account.id;
      if (account.name !== undefined) existing.name = account.name;
      if (account.type !== undefined) existing.type = account.type;
      return existing;
    }
    const clone: TrustedAccount = { ...account };
    currentByKey.set(key, clone);
    currentOrder.push(clone);
    return clone;
  };
  /** Resolve the account a write debited: explicit id, else the single CHECKING account, else lone. */
  const resolveTarget = (accountId?: string): TrustedAccount | undefined => {
    if (accountId !== undefined && accountId !== '') {
      for (const account of currentOrder) if (account.id === accountId) return account;
      return undefined;
    }
    const checking = currentOrder.filter((account) => account.type === 'CHECKING');
    if (checking.length === 1) return checking[0];
    return currentOrder.length === 1 ? currentOrder[0] : undefined;
  };

  for (const entry of results) {
    const { toolName, result } = entry;
    if (toolName === 'get_balance') {
      const data = result.data;
      if (isRecord(data)) {
        if (isFiniteNumber(data.totalAvailable)) totalBalance = data.totalAvailable;
        if (Array.isArray(data.accounts)) {
          for (const raw of data.accounts) {
            if (!isRecord(raw) || !isFiniteNumber(raw.balance)) continue;
            const account: TrustedAccount = {
              balance: raw.balance,
              ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
              ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
              ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
            };
            accounts.push(account);
            balances.push(raw.balance);
            upsertCurrent(account);
          }
        }
      }
    }
    if (toolName === 'get_dashboard_summary') {
      const data = result.data;
      if (isRecord(data)) {
        for (const key of ['checkingBalance', 'totalAssets', 'creditAvailable'] as const) {
          if (isFiniteNumber(data[key])) balances.push(data[key]);
        }
      }
    }
    if (SIDE_EFFECT_TOOLS.has(toolName)) {
      const write = toTrustedWrite(toolName, result, entry);
      writes.push(write);
      // A SUCCESSFUL write that reported a new balance updates its account's CURRENT balance.
      if (write.outcome === 'succeeded' && write.balanceAfter !== undefined) {
        const target = resolveTarget(entry.sourceAccountId ?? write.accountId);
        if (target !== undefined) target.balance = write.balanceAfter;
      }
    }
  }

  return {
    accounts,
    currentBalances: currentOrder,
    balances,
    ...(totalBalance !== undefined ? { totalBalance } : {}),
    writes,
    hasToolResults: results.length > 0,
  };
}

/** Map one REAL write result into its structured trusted form (identity / amount / recipient / balance). */
function toTrustedWrite(toolName: string, result: ToolExecutionResult, entry: FactInput): TrustedWrite {
  const outcome: TrustedWriteOutcome =
    result.ok === true ? 'succeeded' : isUnknownOutcome(result) ? 'unknown' : 'failed';
  const data = isRecord(result.data) ? result.data : undefined;
  const write: TrustedWrite = { toolName, outcome };

  if (entry.toolCallId !== undefined && entry.toolCallId !== '') write.toolCallId = entry.toolCallId;
  if (entry.actionId !== undefined && entry.actionId !== '') write.actionId = entry.actionId;
  if (entry.taskId !== undefined && entry.taskId !== '') write.taskId = entry.taskId;
  if (entry.nodeId !== undefined && entry.nodeId !== '') write.nodeId = entry.nodeId;
  if (entry.sourceAccountId !== undefined && entry.sourceAccountId !== '') {
    write.accountId = entry.sourceAccountId;
  }

  if (data !== undefined) {
    if (isFiniteNumber(data.amount)) write.amount = data.amount;
    if (isFiniteNumber(data.newBalance)) write.balanceAfter = data.newBalance;
    const recipient = toRecipient(data.recipient);
    if (recipient !== undefined) write.recipient = recipient;
    if (write.accountId === undefined) {
      for (const key of ['accountId', 'sourceAccountId'] as const) {
        if (typeof data[key] === 'string' && data[key] !== '') {
          write.accountId = data[key] as string;
          break;
        }
      }
    }
  }
  if (result.summary !== undefined) write.summary = result.summary;
  if (result.error !== undefined) write.error = result.error;
  return write;
}

/**
 * A write whose outcome is EXPLICITLY reported as unknown (the SDK/action marks an inconclusive
 * result — e.g. it needs manual reconciliation). Server-authored markers only, never model text.
 */
function isUnknownOutcome(result: ToolExecutionResult): boolean {
  const data = isRecord(result.data) ? result.data : undefined;
  if (data !== undefined) {
    if (data.outcome === 'unknown' || data.needsReconciliation === true) return true;
  }
  const message = `${result.error ?? ''} ${result.summary ?? ''}`;
  return /人工核对|无法核实|待核对|needs reconciliation/i.test(message);
}

function toRecipient(value: unknown): TrustedRecipient | undefined {
  if (!isRecord(value)) return undefined;
  const recipient: TrustedRecipient = {};
  if (typeof value.name === 'string' && value.name !== '') recipient.name = value.name;
  if (typeof value.contactId === 'string' && value.contactId !== '') recipient.contactId = value.contactId;
  if (typeof value.phone === 'string' && value.phone !== '') recipient.phone = value.phone;
  return Object.keys(recipient).length === 0 ? undefined : recipient;
}

/* --------------------------------------------------------------------------- operation claims */

/** The operation families the model can claim to have completed, mapped to their real tools. */
export type OperationCategory =
  | 'transfer'
  | 'card_limit'
  | 'freeze_card'
  | 'unfreeze_card'
  | 'report_lost_card'
  | 'virtual_card'
  | 'cancel_subscription'
  | 'subscription_reminder'
  | 'scheduled_task'
  | 'budget'
  | 'invest_subscribe'
  | 'invest_redeem'
  | 'change_password';

/** For each operation family: the tool(s) that perform it and the bilingual trigger words. */
export const OPERATION_CATEGORIES: Record<
  OperationCategory,
  { tools: readonly string[]; triggers: readonly string[] }
> = {
  transfer: {
    tools: ['transfer_money'],
    triggers: ['转账', '转出', '汇款', '打款', '收到', '到账', 'transfer', 'remit'],
  },
  card_limit: { tools: ['set_card_limit'], triggers: ['限额', '额度', 'limit'] },
  freeze_card: { tools: ['freeze_card'], triggers: ['冻结', 'freeze'] },
  unfreeze_card: { tools: ['unfreeze_card'], triggers: ['解冻', 'unfreeze'] },
  report_lost_card: { tools: ['report_lost_card'], triggers: ['挂失', 'lost card', 'report lost'] },
  virtual_card: { tools: ['apply_virtual_card'], triggers: ['虚拟卡', 'virtual card'] },
  cancel_subscription: {
    tools: ['cancel_subscription'],
    triggers: ['取消订阅', '退订', 'unsubscribe', 'cancel subscription'],
  },
  subscription_reminder: {
    tools: ['set_subscription_reminder'],
    triggers: ['扣费提醒', '订阅提醒', 'billing reminder', 'subscription reminder'],
  },
  scheduled_task: {
    tools: ['create_scheduled_task'],
    triggers: ['定时任务', '预约任务', 'scheduled task'],
  },
  budget: { tools: ['reserve_budget'], triggers: ['预留', '预算', 'budget', 'reserve'] },
  invest_subscribe: { tools: ['subscribe_investment'], triggers: ['申购', '认购', 'subscribe'] },
  invest_redeem: { tools: ['redeem_investment'], triggers: ['赎回', 'redeem'] },
  change_password: { tools: ['change_password'], triggers: ['修改密码', 'password'] },
};

/** What a clause asserts about the operation it mentions. */
export type AssertionKind = 'done' | 'failed' | 'pending' | 'none';

/** One operation claim found in the text. */
export interface OperationClaim {
  category: OperationCategory;
  assertion: AssertionKind;
  /**
   * The claim WINDOW: the clause the trigger was found in PLUS its following neighbours (a claim's
   * amount/recipient may sit in a neighbouring clause, e.g. 「转账成功，金额30000元，收款人李华。」).
   * The amount/recipient are read from here.
   */
  clause: string;
}

/** Markers that assert an operation is DONE (zh). */
const DONE_MARKERS_ZH: readonly string[] = [
  '已成功',
  '成功',
  '已完成',
  '已执行',
  '执行完成',
  '已办理',
  '已处理',
  '已生效',
  '已到账',
  '已存入',
  '已扣除',
  '已开通',
  '已取消',
  '已冻结',
  '已解冻',
  '已挂失',
  '已设置',
];
/** Markers that assert an operation is DONE (en). */
const DONE_MARKERS_EN: readonly string[] = ['success', 'completed', 'complete', 'processed', 'done'];

/** Markers that assert an operation FAILED / did NOT happen (zh). */
const FAIL_MARKERS_ZH: readonly string[] = [
  '失败',
  '未成功',
  '未完成',
  '未能',
  '无法',
  '不足',
  '尚未',
  '未通过',
  '未发生',
  '未变动',
  '没有发生',
  '被拒',
  '拒绝',
  '超出',
  '不允许',
  '不够',
];
/** Markers that assert an operation FAILED (en). */
const FAIL_MARKERS_EN: readonly string[] = [
  'failed',
  'unsuccessful',
  'declined',
  'rejected',
  'insufficient',
  'not completed',
  'not executed',
  'no change',
  'unchanged',
];

/** Markers that put the operation in a PENDING state (awaiting a human decision) (zh). */
const PENDING_MARKERS_ZH: readonly string[] = [
  '等待',
  '待确认',
  '待处理',
  '待验证',
  '尚未执行',
  '尚未进行',
  '即将',
  '稍后',
];

/** A clause that mentions confirmation/verification alongside the operation is awaiting a decision. */
function isConfirmationClause(clause: string): boolean {
  if (/(await|confirm|verif|pending)/i.test(clause)) return true;
  return /(确认|验证)/.test(clause) && /(需|请|待|等待|后)/.test(clause);
}

/** Classify what a clause asserts, using the (small, per-category) bilingual marker sets. */
function analyzeAssertion(clause: string): AssertionKind {
  if (PENDING_MARKERS_ZH.some((m) => clause.includes(m)) || isConfirmationClause(clause)) {
    return 'pending';
  }
  if (
    FAIL_MARKERS_ZH.some((m) => clause.includes(m)) ||
    FAIL_MARKERS_EN.some((m) => clause.toLowerCase().includes(m))
  ) {
    return 'failed';
  }
  if (
    DONE_MARKERS_ZH.some((m) => clause.includes(m)) ||
    DONE_MARKERS_EN.some((m) => clause.toLowerCase().includes(m))
  ) {
    return 'done';
  }
  return 'none';
}

/** `已…<trigger>` is a completion claim even without an explicit marker (e.g. 「已向 张伟 转账」). */
function isDoneByVerb(clause: string, triggers: readonly string[]): boolean {
  const doneAt = clause.indexOf('已');
  if (doneAt < 0) return false;
  for (const trigger of triggers) {
    let at = clause.indexOf(trigger);
    while (at >= 0) {
      if (at > doneAt && at - doneAt <= 8) return true;
      at = clause.indexOf(trigger, at + 1);
    }
  }
  return false;
}

/** How many CLAUSES a claim window spans (the trigger clause + this many following neighbours). */
const CLAIM_WINDOW_SIZE = 3;

/** Extract every operation claim the text makes, one per (clause, category). */
export function extractOperationClaims(text: string): OperationClaim[] {
  const clauses = splitClauses(text);
  const claims: OperationClaim[] = [];
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    // A claim's supporting details (amount, recipient) may live in NEIGHBOURING clauses, so the
    // window (not just the trigger clause) is what the structural comparison reads.
    const window = clauses.slice(i, i + CLAIM_WINDOW_SIZE).join('，');
    for (const [category, spec] of Object.entries(OPERATION_CATEGORIES) as Array<
      [OperationCategory, { tools: readonly string[]; triggers: readonly string[] }]
    >) {
      const hit = spec.triggers.some((trigger) => clause.toLowerCase().includes(trigger.toLowerCase()));
      if (!hit) continue;
      let assertion = analyzeAssertion(window);
      if (assertion === 'none' && isDoneByVerb(window, spec.triggers)) assertion = 'done';
      claims.push({ category, assertion, clause: window });
    }
  }
  return claims;
}

/* --------------------------------------------------------------------------- money / entity claims */

/** Absolute tolerance (¥) for matching a claimed amount against an authoritative one. */
export const MONEY_TOLERANCE = 0.01;

/** True iff the two amounts are the same money value. */
export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= MONEY_TOLERANCE;
}

/**
 * Clause separator: sentence terminators AND separators. A comma INSIDE a number (a thousands
 * separator, e.g. `¥23,580.00`) is deliberately NOT a separator — splitting there truncates the
 * amount into a bogus small claim (23) and mis-corrects an honest statement.
 */
const CLAUSE_SEPARATOR = /[。；;！!？?\n，]|,(?![0-9])|(?<![0-9]),/;
/** Split text into clauses on sentence terminators AND separators (keeps claims locally scoped). */
function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
}

/** Strip masked card / account numbers so they are never read as amounts. */
function stripMaskedNumbers(text: string): string {
  return text.replace(/[*＊·]{2,}\s*\d{2,}/g, '').replace(/\d{2,}\s*[*＊·]{2,}/g, '');
}

const CURRENCY_AMOUNT = /(?:¥|￥|CNY|RMB)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*元/gi;

/** Every amount the clause marks as MONEY (currency-marked) — card masks excluded. */
export function extractMoneyAmounts(clause: string): number[] {
  const cleaned = stripMaskedNumbers(clause);
  const amounts: number[] = [];
  let match: RegExpExecArray | null;
  CURRENCY_AMOUNT.lastIndex = 0;
  while ((match = CURRENCY_AMOUNT.exec(cleaned)) !== null) {
    const value = parseAmount(match[1] ?? match[2] ?? '');
    if (Number.isFinite(value)) amounts.push(value);
  }
  return amounts;
}

/**
 * A bare (currency-UNMARKED) number that sits IMMEDIATELY after a money word (转账/金额/…). Stops an
 * unmarked amount (e.g. 「已成功向张伟转账30000。」) from being invisible to the structural check,
 * WITHOUT reading every stray digit in the sentence as money.
 */
const MONEY_WORD_AMOUNT = /(?:转账|转出|汇款|打款|金额|转给|amount|transfer)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;

/**
 * Every amount a claim asserts: currency-marked amounts PLUS bare amounts directly introduced by a
 * money word. Card masks excluded. Used by the payment-detail mismatch check.
 */
export function extractClaimAmounts(clause: string): number[] {
  const amounts = extractMoneyAmounts(clause);
  const cleaned = stripMaskedNumbers(clause);
  let match: RegExpExecArray | null;
  MONEY_WORD_AMOUNT.lastIndex = 0;
  while ((match = MONEY_WORD_AMOUNT.exec(cleaned)) !== null) {
    const value = parseAmount(match[1] ?? '');
    if (Number.isFinite(value) && !amounts.some((amount) => sameAmount(amount, value))) amounts.push(value);
  }
  return amounts;
}

/** The recipient a clause names (zh 「向/给 X 转账」 or en 「transfer … to X」), when stated. */
export function extractClaimedRecipient(clause: string): string | undefined {
  const zh = /(?:向|给|转给)\s*([^\s，。、,;；:：0-9¥￥*＊]{1,12}?)\s*(?:转账|汇款|转出|打款|转账|转)/.exec(clause);
  if (zh !== null && zh[1] !== undefined && zh[1] !== '') return zh[1];
  const en = /\bto\s+([A-Za-z][A-Za-z.'\- ]{0,30}?)(?=[\s,.!?]|$)/i.exec(clause);
  if (en !== null && en[1] !== undefined) return en[1].trim();
  return undefined;
}

/* --------------------------------------------------------------------------- balance claims */

/** A balance-labeled amount the text states, with the account hint it points at (if any). */
export interface BalanceClaim {
  amount: number;
  /** The account the claim points at (resolved from the surrounding text), when unambiguous. */
  account?: TrustedAccount;
}

const BALANCE_KEYWORDS: readonly string[] = [
  '可用余额',
  '余额合计',
  '账户余额',
  '可用总额',
  '账户总额',
  '余额',
  'balance',
];

const ACCOUNT_TYPE_KEYS: Record<string, readonly string[]> = {
  CHECKING: ['活期', 'checking'],
  SAVINGS: ['储蓄', 'savings'],
  CREDIT: ['信用', 'credit'],
};

/** The identifying words for an account: its name plus its type synonyms (zh + en). */
export function accountKeys(account: TrustedAccount): string[] {
  const keys: string[] = [];
  if (account.name !== undefined && account.name !== '') keys.push(account.name);
  if (account.type !== undefined) keys.push(...(ACCOUNT_TYPE_KEYS[account.type] ?? []));
  return keys;
}

/** The account a text window points at (a window may only match ONE account to count as a hint). */
function accountHintedBy(window: string, accounts: readonly TrustedAccount[]): TrustedAccount | undefined {
  const lower = window.toLowerCase();
  const matches = accounts.filter((account) =>
    accountKeys(account).some((key) => lower.includes(key.toLowerCase())),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A connector that DIRECTLY introduces a balance value (zh + en) — a balance is only ASSERTED when
 * the number is introduced this way, never when it merely sits near the keyword (e.g. the comparison
 * `balance 23580 < amount 30000` inside an error detail is NOT a claim).
 */
const BALANCE_CONNECTOR = '(?:为|是|等于|：|:|＝|=|\\bis\\b|\\bof\\b)';
/** A currency PREFIX that directly tags a balance value. */
const CURRENCY_PREFIX = '(?:¥|￥|CNY|RMB)';
/** A currency SUFFIX that directly tags a balance value. */
const CURRENCY_SUFFIX = '(?:元|块)';

/**
 * Match an ASSERTED balance amount that IMMEDIATELY follows the balance keyword, allowing only
 * whitespace, a connector and/or a currency marker in between. Groups: (1) connector, (2) currency
 * prefix, (3) the number, (4) currency suffix. A value counts as ASSERTED only when a connector OR
 * a currency marker (prefix/suffix) introduces it with no other word in between — so a bare
 * comparison (`balance 23580`) or a condition phrase (`余额不足 ¥30,000`) never counts.
 */
const ASSERTED_BALANCE = new RegExp(
  '^[\\s]*' +
    `(?:(${BALANCE_CONNECTOR})[\\s]*)?` +
    `(?:(${CURRENCY_PREFIX})[\\s]*)?` +
    '([0-9][0-9,]*(?:\\.[0-9]{1,2})?)' +
    `(?:[\\s]*(${CURRENCY_SUFFIX}))?`,
  'i',
);

/** Extract every balance-labeled amount (+ the account it points at) from the text. */
export function extractBalanceClaims(
  text: string,
  accounts: readonly TrustedAccount[],
): BalanceClaim[] {
  const claims: BalanceClaim[] = [];
  for (const clause of splitClauses(text)) {
    const lower = clause.toLowerCase();
    for (const keyword of BALANCE_KEYWORDS) {
      const at = lower.indexOf(keyword.toLowerCase());
      if (at < 0) continue;
      const after = clause.slice(at + keyword.length, at + keyword.length + 26);
      const match = ASSERTED_BALANCE.exec(after);
      if (match === null) continue;
      // The number must be INTRODUCED by a connector or a currency marker — a bare number that
      // merely follows the keyword (a comparison, a condition, an error detail) is not a claim.
      if (match[1] === undefined && match[2] === undefined && match[4] === undefined) continue;
      const value = parseAmount(match[3] ?? '');
      if (!Number.isFinite(value)) continue;
      const account = accountHintedBy(clause.slice(0, at), accounts);
      claims.push({ amount: value, ...(account !== undefined ? { account } : {}) });
    }
  }
  return claims;
}

/** The CURRENT balance of an account (after every write applied this turn), never a stale as-of one. */
export function currentBalance(
  account: TrustedAccount,
  facts: FinancialFacts,
): number {
  const current = facts.currentBalances ?? [];
  const byId = account.id !== undefined ? current.find((item) => item.id === account.id) : undefined;
  if (byId !== undefined) return byId.balance;
  const byIdentity = current.find(
    (item) => item.name === account.name && item.type === account.type,
  );
  return byIdentity !== undefined ? byIdentity.balance : account.balance;
}

/* ------------------------------------------------------------------------------------ helpers */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
