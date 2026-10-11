/**
 * grounding.ts — SERVER-SIDE FACT GROUNDING for the assistant's final natural-language text.
 *
 * The model's prose is RAW output. This module is the code-enforced HALLUCINATION GUARD that the
 * prompt rule (`./system-prompt.ts#HALLUCINATION_RULE`) can only *ask* the model to respect: it
 * compares the final assistant text against the AUTHORITATIVE, STRUCTURED server facts collected from
 * the turn's REAL tool results (`./grounding-facts`) and REPLACES an inconsistent message with a
 * server-authored correction. It never appends contradictory text, never invents a fact, and never
 * decides permission — the model decides WHAT to do, code decides WHETHER it is allowed (root
 * invariant).
 *
 * LEGACY COMPATIBILITY ONLY: this prose heuristic is retained for its existing regression suite.
 * It is NOT the production financial output boundary. `run-turn.ts` uses `financial-response.ts`,
 * whose input is real tool results only and which never publishes model-authored prose.
 *
 * Every decision below is best effort — per OPERATION identity (the specific tool call, not the whole tool
 * family), per account (CURRENT balance, not a stale as-of one), per amount, per recipient, per
 * outcome state — never a global "some write succeeded" flag, and never a model-producible text
 * marker. Idempotency is tracked SERVER-SIDE by message id (see `./run-turn`), so a forged tag in the
 * model's text cannot skip verification.
 *
 * PURE: no DB access, no pi imports. The decision is `groundAssistantText`; `buildFinancialFacts` is
 * re-exported from `./grounding-facts` for callers. Both are wired into `./run-turn` at the assistant
 * `message_end` chokepoint (+ a pre-persist safety net) so the FINAL UI text is the grounded one.
 */
import { formatCNY } from '@/lib/money';
import {
  OPERATION_CATEGORIES,
  currentBalance,
  extractBalanceClaims,
  extractClaimAmounts,
  extractClaimedRecipient,
  extractOperationClaims,
  sameAmount,
  type FinancialFacts,
  type TrustedWrite,
} from './grounding-facts';

export { buildFinancialFacts, SIDE_EFFECT_TOOLS } from './grounding-facts';
export type {
  BalanceClaim,
  FactInput,
  FinancialFacts,
  OperationCategory,
  TrustedAccount,
  TrustedRecipient,
  TrustedWrite,
  TrustedWriteOutcome,
} from './grounding-facts';

/** The server tag marking a text the server already corrected (informational only — NOT a skip key). */
export const CORRECTION_TAG = '（系统校正）';

/** No write of the claimed operation exists at all this turn. */
const UNGROUNDED_SUCCESS_STATEMENT =
  `${CORRECTION_TAG}本次对话中未记录到该操作的执行结果，请以系统卡片中的实际数据为准。`;

/** The operation's outcome is genuine but UNKNOWN (inconclusive / needs reconciliation). */
const UNVERIFIABLE_OUTCOME_STATEMENT =
  `${CORRECTION_TAG}该操作结果尚无法核实，请以系统数据为准（待核对）。`;

/** A balance was asserted but no authoritative balance exists this turn. */
const UNVERIFIABLE_BALANCE_STATEMENT =
  `${CORRECTION_TAG}本次对话未查询到可信的账户余额，无法核实该数字，请以系统卡片中的实际数据为准。`;

/**
 * Ground the assistant's final text against the structured authoritative facts. Returns `text`
 * UNCHANGED when it is consistent; otherwise a SERVER-authored Chinese replacement (never an appended
 * contradiction). Distinct corrections COMPOSE.
 */
/** @deprecated Do not use for user-visible financial output. Use renderFinancialResponse instead. */
export function groundAssistantText(text: string, facts: FinancialFacts): string {
  if (text.trim() === '') return text;

  const statements: string[] = [];
  const seen = new Set<string>();
  const push = (statement: string): void => {
    if (seen.has(statement)) return;
    seen.add(statement);
    statements.push(statement);
  };

  for (const claim of extractOperationClaims(text)) {
    const write = matchWrite(facts, claim.category, claim.clause);
    if (claim.assertion === 'done') {
      if (write === undefined) {
        push(UNGROUNDED_SUCCESS_STATEMENT);
      } else if (write.outcome === 'failed') {
        push(failedWriteStatement(write));
      } else if (write.outcome === 'unknown') {
        push(UNVERIFIABLE_OUTCOME_STATEMENT);
      } else if (writeMismatch(claim.clause, write)) {
        push(mismatchStatement(write));
      }
      continue;
    }
    if (claim.assertion === 'failed') {
      // An UNKNOWN outcome may never be asserted as success OR as failure / "funds unchanged".
      if (write === undefined) continue;
      if (write.outcome === 'succeeded') push(succeededWriteStatement(write));
      else if (write.outcome === 'unknown') push(UNVERIFIABLE_OUTCOME_STATEMENT);
      continue;
    }
    // `pending` / `none` — an awaiting-decision or read-only statement is never rewritten.
  }

  for (const claim of extractBalanceClaims(text, facts.accounts)) {
    const verdict = classifyBalanceClaim(claim.amount, claim.account, claim.namedAccountLabel, facts);
    if (verdict === 'ok') continue;
    if (verdict === 'unverifiable') push(UNVERIFIABLE_BALANCE_STATEMENT);
    else push(balanceCorrection(claim.account, facts));
  }

  return statements.length === 0 ? text : statements.join(' ');
}

/* ------------------------------------------------------------------------------- rule internals */

/**
 * Match a completion/failure claim to the SPECIFIC operation it refers to, never to the whole tool
 * family (the old "prefer the latest success" picker conflated two distinct same-tool operations).
 * Discriminators, in order: an explicit ordinal (第一笔/第二次/…), an amount that matches exactly one
 * operation, a recipient that matches exactly one operation. When several same-tool operations exist
 * and the claim cannot be bound to one, return `undefined` so the claim is corrected as ungrounded
 * (「未记录到该操作的执行结果」) rather than accepted against the wrong operation.
 */
function matchWrite(facts: FinancialFacts, category: string, window: string): TrustedWrite | undefined {
  const tools = operationTools(category);
  const candidates = facts.writes.filter((write) => tools.includes(write.toolName));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const ordinal = ordinalIndex(window);
  if (ordinal !== undefined && ordinal >= 0 && ordinal < candidates.length) return candidates[ordinal];

  const claimedAmounts = extractClaimAmounts(window);
  if (claimedAmounts.length > 0) {
    const byAmount = candidates.filter(
      (write) => write.amount !== undefined && claimedAmounts.some((amount) => sameAmount(amount, write.amount!)),
    );
    if (byAmount.length === 1) return byAmount[0];
  }

  const claimedRecipient = extractClaimedRecipient(window);
  if (claimedRecipient !== undefined) {
    const byRecipient = candidates.filter(
      (write) => write.recipient?.name !== undefined && sameName(claimedRecipient, write.recipient.name),
    );
    if (byRecipient.length === 1) return byRecipient[0];
  }

  return undefined;
}

/** The zh/en ordinal an operation claim names (第一笔/第二次/…), 0-based; `undefined` when absent. */
function ordinalIndex(window: string): number | undefined {
  const zhDigits: Record<string, number> = {
    一: 0,
    二: 1,
    两: 1,
    三: 2,
    四: 3,
    五: 4,
    六: 5,
    七: 6,
    八: 7,
    九: 8,
    十: 9,
  };
  const match = /第\s*([一二两三四五六七八九十1-9])\s*(?:笔|次|个|项)?/.exec(window);
  if (match === null) return undefined;
  const token = match[1];
  if (/[1-9]/.test(token)) return Number(token) - 1;
  return zhDigits[token];
}

function operationTools(category: string): readonly string[] {
  return OPERATION_CATEGORIES[category as keyof typeof OPERATION_CATEGORIES]?.tools ?? [];
}

/** Does the claim contradict the authoritative amount / recipient of the matched write? */
function writeMismatch(window: string, write: TrustedWrite): boolean {
  if (write.amount !== undefined) {
    const claimed = extractClaimAmounts(window);
    if (claimed.length > 0 && !claimed.some((amount) => sameAmount(amount, write.amount!))) return true;
  }
  if (write.recipient?.name !== undefined) {
    const claimedRecipient = extractClaimedRecipient(window);
    if (claimedRecipient !== undefined && !sameName(claimedRecipient, write.recipient.name)) return true;
  }
  return false;
}

function sameName(a: string, b: string): boolean {
  const left = a.replace(/\s+/g, '').toLowerCase();
  const right = b.replace(/\s+/g, '').toLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

/** A claim of completion when the operation genuinely FAILED. */
function failedWriteStatement(write: TrustedWrite): string {
  const detail = write.error ?? write.summary ?? '';
  return `${CORRECTION_TAG}该操作实际执行失败${detail !== '' ? `：${detail}` : '。'}`;
}

/** A claim of failure when the operation genuinely SUCCEEDED. */
function succeededWriteStatement(write: TrustedWrite): string {
  const detail = write.summary ?? '';
  return `${CORRECTION_TAG}该操作实际执行成功${detail !== '' ? `：${detail}` : '。'}`;
}

/** A completion claim whose STRUCTURED amount / recipient contradicts the real write result. */
function mismatchStatement(write: TrustedWrite): string {
  const parts: string[] = [];
  if (write.recipient?.name !== undefined) parts.push(`收款人 ${write.recipient.name}`);
  if (write.amount !== undefined) parts.push(`金额 ${formatCNY(write.amount)}`);
  if (parts.length === 0) {
    return write.summary !== undefined
      ? `${CORRECTION_TAG}本次操作的实际结果为：${write.summary}`
      : UNVERIFIABLE_OUTCOME_STATEMENT;
  }
  return `${CORRECTION_TAG}本次操作的实际结果为：${parts.join('，')}。`;
}

/** Verdict for one balance claim: consistent, contradictory, unverifiable (no authority), or skipped. */
function classifyBalanceClaim(
  amount: number,
  account: Parameters<typeof balanceCorrection>[0],
  namedAccountLabel: string | undefined,
  facts: FinancialFacts,
): 'ok' | 'wrong' | 'unverifiable' {
  // A claim against a specific account is compared to that account's CURRENT balance (after every
  // write applied this turn), never to a stale as-of-query value.
  if (account !== undefined) return sameAmount(amount, currentBalance(account, facts)) ? 'ok' : 'wrong';
  // A claim that NAMED an account type absent from this turn's authoritative accounts stays bound to
  // that (unknown) account: it can never be satisfied by another account's coincidentally-equal
  // balance, so it is unverifiable rather than matched against the flat amount pool.
  if (namedAccountLabel !== undefined) return 'unverifiable';
  const authoritative = authoritativeAmounts(facts);
  if (authoritative.length === 0) return 'unverifiable';
  return authoritative.some((actual) => sameAmount(actual, amount)) ? 'ok' : 'wrong';
}

/** Every authoritative amount a balance claim may legitimately match (per account / total / after-write). */
function authoritativeAmounts(facts: FinancialFacts): number[] {
  const amounts = [...facts.balances];
  if (facts.totalBalance !== undefined) amounts.push(facts.totalBalance);
  for (const account of facts.currentBalances ?? []) amounts.push(account.balance);
  for (const write of facts.writes) if (write.balanceAfter !== undefined) amounts.push(write.balanceAfter);
  return amounts;
}

/** Build the server-authored balance statement, per account when the claim pointed at one. */
function balanceCorrection(
  account: { id?: string; name?: string; type?: string; balance: number } | undefined,
  facts: FinancialFacts,
): string {
  if (account !== undefined) {
    const label = account.name ?? account.type ?? '该账户';
    return `${CORRECTION_TAG}${label}的余额为 ${formatCNY(currentBalance(account, facts))}，请以系统数据为准。`;
  }
  if (facts.totalBalance !== undefined) {
    return `${CORRECTION_TAG}你的账户可用余额合计为 ${formatCNY(facts.totalBalance)}。`;
  }
  const listed = (facts.currentBalances ?? facts.accounts)
    .map((item) => `${item.name ?? item.type ?? '账户'} ${formatCNY(item.balance)}`)
    .join('、');
  return `${CORRECTION_TAG}你的账户余额为：${listed}。`;
}
