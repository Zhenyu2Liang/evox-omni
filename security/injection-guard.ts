/**
 * Injection Guard — heuristic detection of prompt-injection / jailbreak attempts.
 *
 * ⚠️ DISCLAIMER (read this): this module is **defense-in-depth ONLY**. It scans user
 * text for known injection signatures to (a) record a `SecurityEvent` and (b) let the
 * agent layer add a system reminder. It **NEVER grants, elevates, or bypasses
 * permission** — authorization is decided exclusively by `security-gateway` /
 * `permission-engine` from the static policy table + dynamic rules. A miss here (or a
 * clever phrasing) changes nothing about what the model is allowed to execute.
 *
 * `scan` is PURE and side-effect-free (so it is trivially unit-testable); the caller
 * (the gateway / agent layer, which owns `sessionId`) invokes `reportInjection` at the
 * async boundary to persist the event.
 */
import { recordSecurityEvent } from '../audit';

export interface InjectionScanResult {
  suspicious: boolean;
  /** Stable ids of the signatures that matched. */
  matched: string[];
  /** Human-readable (Chinese) summary for the audit log / system reminder. */
  note: string;
}

/** Prompt-injection signatures (data only; matching logic lives in `scan`). */
export const INJECTION_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; label: string }> = [
  { id: 'ignore-rules-zh', pattern: /忽略(之前|以上|所有)?(的)?(规则|指令|限制|提示|要求)/i, label: '忽略规则' },
  { id: 'ignore-previous-en', pattern: /ignore\s+(the\s+)?(previous|above|all|prior)\s+(instructions?|rules?|prompts?)/i, label: 'ignore previous instructions' },
  { id: 'become-admin', pattern: /你(现在)?是(管理员|开发者|root|系统)/i, label: '越权身份声明' },
  { id: 'no-confirmation', pattern: /(不要|无需|跳过|绕过|免去).*(确认|验证|审核)/i, label: '绕过确认' },
  { id: 'direct-transfer', pattern: /直接(转账|付款|打款)/i, label: '直接转账' },
  { id: 'system-prompt', pattern: /(system\s*prompt|系统提示词|泄露.*提示)/i, label: '探测系统提示' },
  { id: 'shell-exec', pattern: /(执行|运行|调用).*(shell|命令|脚本|cmd|bash|powershell)/i, label: '请求执行 shell' },
  { id: 'sql-injection', pattern: /(drop\s+table|delete\s+from|;\s*--|union\s+select|truncate\s+table)/i, label: 'SQL 注入' },
  { id: 'jailbreak', pattern: /(开发者模式|developer\s*mode|jailbreak|越狱|DAN\b)/i, label: '越狱模式' },
];

/**
 * Pure, deterministic scan of `text`. Returns whether any injection signature matched
 * plus the matched ids and a human-readable note. NO side effects.
 */
export function scan(text: string): InjectionScanResult {
  throw new Error('not implemented');
}

/**
 * Persist an `INJECTION_ATTEMPT` SecurityEvent when `result.suspicious` (no-op otherwise).
 * Called by the gateway/agent layer, which owns `sessionId`. Awaitable — errors are not swallowed.
 */
export async function reportInjection(
  sessionId: string,
  text: string,
  result: InjectionScanResult,
): Promise<void> {
  throw new Error('not implemented');
}
