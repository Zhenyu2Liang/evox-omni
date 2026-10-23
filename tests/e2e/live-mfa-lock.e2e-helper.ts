/**
 * `tests/e2e/live-mfa-lock.e2e-helper.ts` — body of LIVE scenario `lH`:
 * the MFA attempt limit → TERMINAL `locked` state, end to end in a real browser with a live model.
 *
 * WHAT `lH` PROVES (and why no existing entry can):
 *
 *  - Scenario `4` (`scenarioLargeTransferMfa`) submits ONE wrong code and stops — it can only show the
 *    retryable `awaiting_mfa` path. The mock `j-circuit-breaker-lock` journey submits three wrong codes,
 *    but it runs the MOCK model against `prisma/e2e.db`, so it proves nothing about the real provider
 *    round-trip that produces the lock. `lH` closes exactly that hole: LIVE model → real RED transfer →
 *    three real wrong codes → the terminal lock, then a refresh and the security centre.
 *  - The lock is a **200 domain result** (`status:'locked'`, top-level `code:'CIRCUIT_OPEN'`,
 *    `failure.code:'MFA_LOCKED'`), NEVER a 423/409 transport refusal, so this module asserts the
 *    response ENVELOPE as read from `page.on('response')`, not just the rendered copy.
 *  - The verification DOCK is unmounted in the SAME render that settles the card to its terminal state
 *    (`components/chat/agent-stream-reducer.ts#settleAction` clears `pendingAction` while writing the
 *    card's `status`), so "the MFA card disappeared" is NOT evidence of a lock — it is equally the
 *    shape of a SUCCESS. Every lock assertion here therefore pairs the rendered copy with the
 *    persisted `PendingAction.status`, the `MfaChallenge` row and the `CircuitBreakerState` row.
 *
 * WHY A SEPARATE MODULE: the entry script keeps only registration lines (the `lF`/`lG` precedent). The
 * entry's `driveRedTool` HARD-CODES the correct code `123456`, so it can never drive a wrong-code
 * ladder; `lH` needs its own bounded turn driver that stops on the parked dock and then submits
 * `000000` three times. Everything else is REUSED: browser/chat/panel primitives from `./helpers`,
 * `withDb` / `writeScenarioEvidence` from `./live-virtual-card.e2e-helper`, and every user-visible
 * string from the ONE catalogue the components render from (`createTranslator('zh-CN')`).
 *
 * SCOPE: this file asserts existing product behaviour. It reads but never writes product code — the
 * known dock-badge rendering gap (a wrong code shows the generic `chat.error.request` sentence instead
 * of the remaining-attempts sentence) is recorded as EVIDENCE in the returned string, not "fixed" here.
 *
 * This file carries no `.test.`/`.spec.` suffix and is never collected by Vitest.
 */
import type { Page, Response } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import {
  SELECTORS,
  assertNoFabricatedConfirmationPanel,
  assistantTexts,
  clickConfirm,
  diffLedger,
  fetchLedger,
  fetchPendingActions,
  getJson,
  gotoAgent,
  mfaCardPresent,
  queryPendingActionStatus,
  querySecurityEvents,
  readDemoSessionId,
  submitChat,
  submitMfa,
  waitFor,
  waitForComposerHydration,
  waitForMfaCard,
  waitForStatusText,
  type LedgerTransaction,
} from './helpers';
import { withDb, writeScenarioEvidence } from './live-virtual-card.e2e-helper';

const t = createTranslator('zh-CN');

// --- fixed facts of the chain ---------------------------------------------------------------------

/** The SAME RED prompt `scenarioLargeTransferMfa` uses: `给张伟转5000元` (risk tier 🔴 → MFA, no confirm). */
const TRANSFER_TURN = '给张伟转5000元';
/**
 * Bounded natural-language nudges for the ONE known live-model wobble: it narrates a question instead
 * of calling the gated tool. Same shape as the entry's `driveRedTool`, but it never submits a code —
 * `lH` must stay on the wrong-code ladder.
 */
const NUDGE_TURNS: readonly string[] = [
  TRANSFER_TURN,
  '就按5000元转给张伟，请直接发起这笔转账',
  '请继续处理刚才那笔给张伟的5000元转账',
];
/** The wrong code convention used across the suite; `MFA_CODE` is `123456` and is never sent here. */
const WRONG_CODE = '000000';
/** `lib/constants.ts#MFA_MAX_ATTEMPTS` — the threshold that makes the third failure terminal. */
const MAX_ATTEMPTS = 3;
/** `security/circuit-breaker.ts#resolveBreakerOwner` keys a real user's breaker as `user:<userId>`. */
const BREAKER_OWNER_KEY = 'user:user_liming';

/** The verify route: `POST /api/actions/<actionId>/verify`. */
const VERIFY_PATH = /^\/api\/actions\/([^/]+)\/verify$/;

/** Everything `lH` needs from the entry script; nothing here is re-implemented side-band. */
export interface MfaLockParams {
  page: Page;
  baseUrl: string;
  /** The entry's module-private `captureLive` — injected so the screenshot pipeline stays single-source. */
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
}

// --- captured wire + DOM facts --------------------------------------------------------------------

/** One `verify` round-trip exactly as the browser received it. */
interface VerifyCall {
  actionId: string;
  httpStatus: number;
  /** The RAW body text — the (c) leak assertions run over this, verbatim. */
  bodyText: string;
  /** The parsed envelope, or `undefined` when the body was not JSON. */
  body: Record<string, unknown> | undefined;
}

/** What one attempt looked like from the browser: rendered copy + the typed response facts. */
interface AttemptRecord {
  attempt: number;
  /** Whitespace-collapsed text of the actionable dock (absent on the terminal attempt). */
  dockText: string;
  /** Whitespace-collapsed text of every `[role="status"]` on the page. */
  statusTexts: string[];
  /** The rendered `cards.mfa.failedAttempts` counter line, when present. */
  counterLine: string;
  /** `data.status` of the verify response. */
  status: string;
  /** `data.code` (top level) of the verify response. */
  code: string;
  /** `data.mfaResult`. */
  mfaResult: string;
  /** `data.failure` — `{ code, reason, attemptsUsed, attemptsLeft, maxAttempts }` verbatim. */
  failure: Record<string, unknown> | undefined;
  /** Top-level `data.attemptsLeft` / `data.maxAttempts` duplicates. */
  attemptsLeft: number | undefined;
  maxAttempts: number | undefined;
  /** `data.message` — server-owned, INTERNAL; must never reach the page (asserted in (c)). */
  message: string;
}

// --- internal-marker assertions (requirement c) ---------------------------------------------------

interface MarkerRule {
  label: string;
  re: RegExp;
}

/**
 * Patterns that must never appear in TEXT THE USER SEES. `}`-free JSON is covered by the `{"` rule;
 * a raw contract fragment (`"code":"…"`) would be the same leak in another shape.
 */
const DOM_FORBIDDEN: readonly MarkerRule[] = [
  { label: '网关内部标记 __SECURITY_BLOCK__', re: /__SECURITY_BLOCK__/ },
  { label: '内部决策字段 decisionKind', re: /decisionKind/ },
  { label: '原始 JSON 契约片段 "code":"…"', re: /"code"\s*:\s*"/ },
  { label: '原始 JSON 对象片段 { "…" }', re: /\{\s*"/ },
  { label: '异常类名前缀 Error:', re: /\bError:\s/ },
  { label: '堆栈帧 at <文件>:<行>:<列>', re: /\bat\s+[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs):\d+/ },
  { label: '堆栈帧 at Object.<anonymous> / at async', re: /\bat\s+(?:Object\.|Module\.|async\s)/ },
  { label: 'Node 内部路径 node:internal', re: /node:internal/ },
];

/**
 * Patterns additionally forbidden inside the RAW `verify` JSON body. The typed contract fields
 * (`"code":"MFA_FAILED"`) are LEGITIMATE there — that is the whole point of a typed envelope — so the
 * JSON surface is checked only for the marker/stack/`decisionKind` class of leaks.
 */
const JSON_FORBIDDEN: readonly MarkerRule[] = [
  { label: '网关内部标记 __SECURITY_BLOCK__', re: /__SECURITY_BLOCK__/ },
  { label: '内部决策字段 decisionKind', re: /decisionKind/ },
  { label: '异常类名前缀 Error:', re: /\bError:\s/ },
  { label: '堆栈帧 at <文件>:<行>:<列>', re: /\bat\s+[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs):\d+/ },
  { label: 'Node 内部路径 node:internal', re: /node:internal/ },
  { label: '进程/堆栈诊断 stack', re: /\bstack\b/i },
];

/** One recorded leak check, so the report can state WHAT was checked, WHERE, and the result. */
export interface MarkerCheck {
  surface: string;
  label: string;
  found: boolean;
}

function scan(text: string, rules: readonly MarkerRule[], surface: string): MarkerCheck[] {
  return rules.map((rule) => ({ surface, label: rule.label, found: rule.re.test(text) }));
}

function throwOnLeak(checks: readonly MarkerCheck[], text: string): void {
  const hit = checks.filter((check) => check.found);
  if (hit.length === 0) return;
  const detail = hit.map((check) => `${check.surface} › ${check.label}`).join('；');
  throw new Error(`发现内部诊断泄漏（${detail}）｜ 原文尾部：${text.replace(/\s+/g, ' ').slice(-400)}`);
}

// --- small browser taps (never re-implemented from the entry script) -------------------------------

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

async function composerEnabled(page: Page): Promise<boolean> {
  const composer = page.locator(SELECTORS.composer).first();
  return (await composer.count()) > 0 && (await composer.isEnabled());
}

async function confirmButtonCount(page: Page): Promise<number> {
  return page.locator(SELECTORS.approvalRequest).getByRole('button', { name: t('cards.confirm'), exact: true }).count();
}

async function dockText(page: Page): Promise<string> {
  const dock = page.locator(SELECTORS.approvalRequest).first();
  if ((await dock.count()) === 0) return '';
  return collapse((await dock.innerText().catch(() => '')) ?? '');
}

async function statusTexts(page: Page): Promise<string[]> {
  const raw = await page.locator('[role="status"]').allInnerTexts();
  return raw.map(collapse).filter((text) => text.length > 0);
}

/** The rendered attempt counter (`cards.mfa.failedAttempts`) — the deterministic wrong-code evidence. */
function findCounterLine(texts: readonly string[]): string {
  return texts.find((text) => text.includes('验证失败，已尝试')) ?? '';
}

/** Whole visible page text (rendered, no `<script>` payloads) — the (c) DOM surface. */
async function visibleBodyText(page: Page): Promise<string> {
  return collapse(await page.locator('body').innerText());
}

// --- turn driver: park the RED dock, never submit a code ------------------------------------------

/**
 * Drive the live model into parking the RED transfer dock.
 *
 * Returns the prompts actually sent plus whether a plain-approval card had to be confirmed first (a
 * 5000 transfer is 🔴, so the expected shape is a direct MFA dock — the confirm branch exists only so a
 * model that books it one tier lower is still driven honestly instead of being nudged forever).
 */
async function ensureMfaDock(
  page: Page,
  baseUrl: string,
): Promise<{ nudges: string[]; confirmFirst: boolean }> {
  const sent: string[] = [];
  let confirmFirst = false;
  for (const turn of NUDGE_TURNS) {
    const baseline = (await assistantTexts(page)).length;
    await submitChat(page, turn);
    sent.push(turn);
    const outcome = await waitFor(
      async () => {
        if (await mfaCardPresent(page)) return 'mfa' as const;
        if ((await confirmButtonCount(page)) > 0) return 'confirm' as const;
        return (await assistantTexts(page)).length > baseline && (await composerEnabled(page))
          ? 'reply' as const
          : false;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 1_000,
        description: `等待 LIVE 模型调用受控转账工具（MFA 停泊区）：${turn}`,
      },
    ).catch(() => 'timeout' as const);
    if (outcome === 'mfa') return { nudges: sent, confirmFirst };
    if (outcome === 'confirm') {
      confirmFirst = true;
      await clickConfirm(page);
      await waitForMfaCard(page, 60_000);
      return { nudges: sent, confirmFirst };
    }
    if (outcome === 'reply') {
      // A model that CLAIMS a panel exists while nothing is parked is a user-visible defect, not a wobble.
      const prose = (await assistantTexts(page)).slice(baseline).join('\n');
      await assertNoFabricatedConfirmationPanel({ page, prose, actions: await fetchPendingActions(baseUrl) });
    }
  }
  // Bounded nudges never parked a dock: one UNWEAKENED wait, so the failure is real model behaviour.
  await waitForMfaCard(page, 60_000);
  return { nudges: sent, confirmFirst };
}

// --- the scenario ---------------------------------------------------------------------------------

/**
 * id `lH` — LIVE MFA attempt limit ⇒ terminal `locked`.
 *
 * Chain: 🔴 transfer dock → three wrong codes → lock → refresh → security centre.
 * Returns ONE evidence string; throws (never skips) when any assertion fails.
 */
export async function scenarioMfaAttemptLimitLock(params: MfaLockParams): Promise<string> {
  const { page, baseUrl, captureShot } = params;

  // ---- wire capture: the verify envelope EXACTLY as the browser received it ---------------------
  const verifyCalls: VerifyCall[] = [];
  const inflight: Promise<void>[] = [];
  const onResponse = (response: Response): void => {
    if (response.request().method() !== 'POST') return;
    let pathname: string;
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      return;
    }
    const match = VERIFY_PATH.exec(pathname);
    if (match === null) return;
    const actionId = match[1]!;
    inflight.push(
      (async () => {
        const bodyText = await response.text().catch(() => '');
        let body: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(bodyText);
          body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
        } catch {
          body = undefined;
        }
        verifyCalls.push({ actionId, httpStatus: response.status(), bodyText, body });
      })(),
    );
  };
  page.on('response', onResponse);

  const awaitVerifyCall = async (expected: number): Promise<VerifyCall> => {
    await waitFor(async () => (verifyCalls.length >= expected ? true : false), {
      timeoutMs: 45_000,
      description: `第 ${expected} 次 POST /api/actions/[id]/verify 的响应`,
    });
    // Let the just-arrived body settle, then hand back the call.
    await Promise.all([...inflight]);
    const call = verifyCalls[expected - 1];
    if (call === undefined) throw new Error(`第 ${expected} 次 verify 响应缺失`);
    return call;
  };

  const shots: string[] = [];
  const shoot = async (label: string): Promise<void> => {
    const path = await captureShot(page, label);
    if (path !== undefined) shots.push(path);
  };

  try {
    await gotoAgent(page, baseUrl);
    const sessionId = await readDemoSessionId(page);

    // ---- baseline: nothing may move on the whole locked path -----------------------------------
    const beforeLedger = await fetchLedger(baseUrl);
    const beforeTransactions: readonly LedgerTransaction[] = beforeLedger.transactions;

    // ---- park the RED dock ----------------------------------------------------------------------
    const { nudges, confirmFirst } = await ensureMfaDock(page, baseUrl);
    const dock = page.locator(SELECTORS.approvalRequest).first();
    const actionId = await dock.getAttribute('data-action-id');
    if (actionId === null || actionId.trim() === '') {
      throw new Error('MFA 停泊区没有 data-action-id，无法追踪 PendingAction');
    }
    const dockKind = await dock.getAttribute('data-kind');
    await waitForMfaCard(page, 30_000);
    await shoot('lH-mfa-dock');

    // ⚠ the dock is the ONLY actionable surface: it must NOT offer 确认 on a 🔴 transfer.
    const confirmInsideDock = await confirmButtonCount(page);
    if (confirmInsideDock > 0) {
      throw new Error(`🔴 转账停泊区出现了 ${confirmInsideDock} 个「确认」按钮（应为纯 MFA 面板）`);
    }

    // ---- (a) three wrong codes: type + remaining attempts, per attempt ------------------------
    const attempts: AttemptRecord[] = [];
    const domTextsByAttempt: { surface: string; text: string }[] = [];
    let lockedStatusTexts: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await submitMfa(page, WRONG_CODE);
      const call = await awaitVerifyCall(attempt);
      const data = (call.body?.['data'] ?? {}) as Record<string, unknown>;
      const failure = (data['failure'] ?? undefined) as Record<string, unknown> | undefined;

      const record: AttemptRecord = {
        attempt,
        dockText: '',
        statusTexts: [],
        counterLine: '',
        status: String(data['status'] ?? ''),
        code: String(data['code'] ?? ''),
        mfaResult: String(data['mfaResult'] ?? ''),
        failure,
        attemptsLeft: typeof data['attemptsLeft'] === 'number' ? data['attemptsLeft'] : undefined,
        maxAttempts: typeof data['maxAttempts'] === 'number' ? data['maxAttempts'] : undefined,
        message: String(data['message'] ?? ''),
      };

      // The envelope itself must never carry an internal marker, and the typed facts must agree.
      throwOnLeak(scan(call.bodyText, JSON_FORBIDDEN, `verify 响应原文（第 ${attempt} 次）`), call.bodyText);

      if (call.httpStatus !== 200) {
        throw new Error(`第 ${attempt} 次错码应为 HTTP 200 域结果，实际 ${call.httpStatus}：${call.bodyText.slice(0, 300)}`);
      }

      if (attempt < MAX_ATTEMPTS) {
        // Retryable path: dock survives with the counter line rendered in a `role=status`.
        await waitForStatusText(page, t('cards.mfa.failedAttempts', { attempts: attempt }), 45_000);
        record.statusTexts = await statusTexts(page);
        record.dockText = await dockText(page);
        record.counterLine = findCounterLine(record.statusTexts);
        if (record.counterLine === '') {
          throw new Error(`第 ${attempt} 次错码后未渲染「验证失败，已尝试 ${attempt} 次。」计数行：${record.statusTexts.join(' ｜ ')}`);
        }
        if (!(await mfaCardPresent(page))) {
          throw new Error(`第 ${attempt} 次错码后 MFA 已应保留重试，但验证码输入框消失（status=${record.status}）`);
        }
        domTextsByAttempt.push({ surface: `第 ${attempt} 次错码后 role=status 文本`, text: record.statusTexts.join(' ｜ ') });
        domTextsByAttempt.push({ surface: `第 ${attempt} 次错码后停泊区文本`, text: record.dockText });
      } else {
        // Terminal path: the dock unmounts in the SAME render that writes the terminal card.
        await waitForStatusText(page, t('chat.approval.status.locked'), 60_000);
        lockedStatusTexts = await statusTexts(page);
        record.statusTexts = lockedStatusTexts;
        record.dockText = await dockText(page);
        record.counterLine = findCounterLine(lockedStatusTexts);
      }

      // One screenshot per wrong code, so the evidence pack shows EACH rung of the ladder
      // (1st/2nd keep the dock with the counter line, 3rd shows the terminal lock).
      await shoot(`lH-wrong-${attempt}`);
      attempts.push(record);
    }

    const [first, second, third] = attempts;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('错码阶梯没有完整跑完三次');
    }

    // --- (a) typed truth: failure codes / attemptsUsed / attemptsLeft -------------------------
    const expectedFirst = { status: 'awaiting_mfa', reason: 'mfa_code_invalid', used: 1, left: 2 };
    const expectedSecond = { status: 'awaiting_mfa', reason: 'mfa_code_invalid', used: 2, left: 1 };
    const expectedLocked = { status: 'locked', reason: 'mfa_attempts_exhausted', used: 3, left: 0 };

    for (const [label, record, expected] of [
      ['第 1 次', first, expectedFirst],
      ['第 2 次', second, expectedSecond],
    ] as const) {
      if (record.status !== expected.status) throw new Error(`${label}错码 status 应为 ${expected.status}，实际 ${record.status}`);
      if (record.code !== 'MFA_FAILED') throw new Error(`${label}错码顶层 code 应为 MFA_FAILED，实际 ${record.code}`);
      if (record.mfaResult !== 'failed') throw new Error(`${label}错码 mfaResult 应为 failed，实际 ${record.mfaResult}`);
      if (record.failure?.['reason'] !== expected.reason) {
        throw new Error(`${label}错码 failure.reason 应为 ${expected.reason}，实际 ${String(record.failure?.['reason'])}`);
      }
      if (record.failure?.['code'] !== 'MFA_FAILED') {
        throw new Error(`${label}错码 failure.code 应为 MFA_FAILED，实际 ${String(record.failure?.['code'])}`);
      }
      if (record.failure?.['attemptsUsed'] !== expected.used || record.failure?.['attemptsLeft'] !== expected.left) {
        throw new Error(
          `${label}错码 failure 次数应为 used=${expected.used}/left=${expected.left}，实际 used=${String(record.failure?.['attemptsUsed'])}/left=${String(record.failure?.['attemptsLeft'])}`,
        );
      }
      if (record.attemptsLeft !== expected.left || record.maxAttempts !== MAX_ATTEMPTS) {
        throw new Error(
          `${label}错码顶层 attemptsLeft/maxAttempts 应为 ${expected.left}/${MAX_ATTEMPTS}，实际 ${String(record.attemptsLeft)}/${String(record.maxAttempts)}`,
        );
      }
    }

    if (third.status !== expectedLocked.status) throw new Error(`第 3 次错码 status 应为 locked，实际 ${third.status}`);
    if (third.code !== 'CIRCUIT_OPEN') throw new Error(`第 3 次错码顶层 code 应为 CIRCUIT_OPEN，实际 ${third.code}`);
    if (third.mfaResult !== 'failed') throw new Error(`第 3 次错码 mfaResult 应为 failed，实际 ${third.mfaResult}`);
    if (third.failure?.['code'] !== 'MFA_LOCKED') throw new Error(`第 3 次 failure.code 应为 MFA_LOCKED，实际 ${String(third.failure?.['code'])}`);
    if (third.failure?.['reason'] !== expectedLocked.reason) {
      throw new Error(`第 3 次 failure.reason 应为 ${expectedLocked.reason}，实际 ${String(third.failure?.['reason'])}`);
    }
    if (third.failure?.['attemptsUsed'] !== expectedLocked.used || third.attemptsLeft !== expectedLocked.left) {
      throw new Error(
        `第 3 次 attemptsUsed/attemptsLeft 应为 ${expectedLocked.used}/${expectedLocked.left}，实际 ${String(third.failure?.['attemptsUsed'])}/${String(third.attemptsLeft)}`,
      );
    }

    // --- (c) leak scan over the DOM of the WHOLE chain --------------------------------------
    const lockedBody = await visibleBodyText(page);
    domTextsByAttempt.push({ surface: '锁定后全页可见文本', text: lockedBody });
    const markerChecks: MarkerCheck[] = [];
    for (const surface of domTextsByAttempt) {
      markerChecks.push(...scan(surface.text, DOM_FORBIDDEN, surface.surface));
    }
    for (const call of verifyCalls) {
      markerChecks.push(...scan(call.bodyText, JSON_FORBIDDEN, `verify 响应原文（actionId ${call.actionId}）`));
    }
    throwOnLeak(markerChecks, `${lockedBody} ${verifyCalls.map((call) => call.bodyText).join(' ')}`);

    // The locked copy MUST be present verbatim, and the retryable copy must be GONE.
    const actionLockedCopy = t('chat.error.actionLocked');
    if (!lockedBody.includes(actionLockedCopy)) {
      throw new Error(`锁定后未见 ${actionLockedCopy}（页面文本尾部：${lockedBody.slice(-400)}）`);
    }
    const lockedBadgeCopy = t('chat.approval.status.locked');
    if (!lockedStatusTexts.some((text) => text.includes(lockedBadgeCopy))) {
      throw new Error(`锁定后 role=status 未见「${lockedBadgeCopy}」：${lockedStatusTexts.join(' ｜ ')}`);
    }

    // --- (a extra) the `securityNotice` `?? 0` probe ----------------------------------------
    // `lib/public-text.ts#securityNoticeParams` falls back to `count: 0` when the failure carries no
    // `attemptsLeft`, so a client-side render of the retryable notice WITHOUT the typed count would
    // print a false "还可尝试 0 次". The envelope above proves the server always sends the count
    // (2 → 1 → 0); this probe records whether any such bogus copy actually reached the page.
    const zeroProbe = [/还可尝试\s*0\s*次/, /剩余尝试次数[：:]\s*0/, /还可尝试\s*-\d/];
    const zeroHits = zeroProbe.filter((re) => re.test(lockedBody));
    const retryCopyPresent = ['还可尝试 2 次', '还可尝试 1 次'].filter((needle) => lockedBody.includes(needle));
    const dockBadgeCopy = t('chat.error.request');

    // --- (b) the verification entry point is gone AND the row is terminal -------------------
    const mfaInputsAfterLock = await page.locator(SELECTORS.mfaInput).count();
    if (mfaInputsAfterLock !== 0) {
      throw new Error(`锁定后验证码输入框计数应为 0，实际 ${mfaInputsAfterLock}`);
    }
    if (await mfaCardPresent(page)) throw new Error('锁定后 mfaCardPresent 仍为 true');
    const dockAfterLock = await page.locator(SELECTORS.approvalRequest).count();
    if (dockAfterLock !== 0) throw new Error(`锁定后操作停泊区仍渲染（计数 ${dockAfterLock}）`);

    const persisted = await queryPendingActionStatus(actionId);
    if (persisted === null) throw new Error(`PendingAction ${actionId} 不存在`);
    if (persisted.status !== 'locked') {
      throw new Error(`PendingAction ${actionId} 的 status 应为 locked，实际 ${persisted.status}`);
    }
    if (persisted.resultJson !== null) {
      throw new Error(`locked 的 PendingAction 不应带 resultJson，实际 ${persisted.resultJson.slice(0, 200)}`);
    }
    const pendingActions = await fetchPendingActions(baseUrl);
    if (pendingActions.some((action) => action.id === actionId)) {
      throw new Error(`GET /api/actions 仍把已锁定操作 ${actionId} 当待处理项返回`);
    }

    const dbFacts = await withDb(async (db) => {
      const action = await db.pendingAction.findUnique({
        where: { id: actionId },
        select: { id: true, status: true, toolName: true, riskLevel: true, requiresMfa: true, updatedAt: true },
      });
      const challenge = await db.mfaChallenge.findUnique({
        where: { actionId },
        select: { actionId: true, attempts: true, maxAttempts: true, status: true, verifiedAt: true, consumedAt: true, expiresAt: true },
      });
      const breaker = await db.circuitBreakerState.findUnique({
        where: { key: BREAKER_OWNER_KEY },
        select: { key: true, userId: true, failures: true, locked: true, lockedAt: true, updatedAt: true },
      });
      return { action, challenge, breaker };
    });

    if (dbFacts.challenge === null) throw new Error(`MfaChallenge(actionId=${actionId}) 不存在`);
    if (dbFacts.challenge.attempts !== MAX_ATTEMPTS) {
      throw new Error(`MfaChallenge.attempts 应为 ${MAX_ATTEMPTS}，实际 ${dbFacts.challenge.attempts}`);
    }
    if (dbFacts.challenge.status !== 'locked') {
      throw new Error(`MfaChallenge.status 应为 locked，实际 ${dbFacts.challenge.status}`);
    }
    if (dbFacts.challenge.maxAttempts !== MAX_ATTEMPTS) {
      throw new Error(`MfaChallenge.maxAttempts 应为 ${MAX_ATTEMPTS}，实际 ${dbFacts.challenge.maxAttempts}`);
    }
    if (dbFacts.breaker === null) throw new Error(`CircuitBreakerState(${BREAKER_OWNER_KEY}) 不存在`);
    if (dbFacts.breaker.locked !== true || dbFacts.breaker.failures !== MAX_ATTEMPTS) {
      throw new Error(
        `CircuitBreakerState 应为 locked=true/failures=${MAX_ATTEMPTS}，实际 locked=${dbFacts.breaker.locked}/failures=${dbFacts.breaker.failures}`,
      );
    }

    // No money may move on the locked path.
    const afterLedger = await fetchLedger(baseUrl);
    const ledgerDiff = diffLedger(beforeTransactions, afterLedger.transactions);
    if (ledgerDiff.added.length > 0) {
      throw new Error(`三次错码后账本新增 ${ledgerDiff.added.length} 条流水：${ledgerDiff.added.map((tx) => `${tx.id}/${tx.amount}`).join('、')}`);
    }

    await shoot('lH-locked-terminal');

    // --- (d) refresh: the lock is durable, no entry point comes back ------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page, 90_000);
    await waitFor(
      async () =>
        (await page.locator('[data-approval-history="true"][data-status="locked"] [data-approval-locked="true"]').count()) > 0
          ? true
          : false,
      { timeoutMs: 90_000, description: '刷新后只读回执显示 [data-status="locked"] + [data-approval-locked]' },
    );
    const reloadedLockedReceipts = await page
      .locator('[data-approval-history="true"][data-status="locked"] [data-approval-locked="true"]')
      .count();
    const reloadedStages = await page
      .locator('[data-approval-stage="current"][data-stage-status="locked"]')
      .count();
    const reloadedInputs = await page.locator(SELECTORS.mfaInput).count();
    const reloadedDock = await page.locator(SELECTORS.approvalRequest).count();
    const reloadedConfirm = await confirmButtonCount(page);
    const reloadedVerify = await page
      .locator(SELECTORS.approvalRequest)
      .getByRole('button', { name: t('cards.verify'), exact: true })
      .count();
    if (reloadedInputs !== 0) throw new Error(`刷新后验证码输入框计数应为 0，实际 ${reloadedInputs}`);
    if (reloadedDock !== 0) throw new Error(`刷新后操作停泊区仍渲染（计数 ${reloadedDock}）`);
    if (reloadedConfirm !== 0 || reloadedVerify !== 0) {
      throw new Error(`刷新后仍出现可点击的确认/验证按钮（确认 ${reloadedConfirm}、验证 ${reloadedVerify}）`);
    }
    if (reloadedLockedReceipts === 0) throw new Error('刷新后只读回执未显示锁定终态');
    const reloadedStatusTexts = await statusTexts(page);
    const reloadedHasLockedCopy = reloadedStatusTexts.some((text) => text.includes(lockedBadgeCopy));
    if (!reloadedHasLockedCopy) {
      throw new Error(`刷新后 role=status 未见「${lockedBadgeCopy}」：${reloadedStatusTexts.join(' ｜ ')}`);
    }
    const reloadedPersisted = await queryPendingActionStatus(actionId);
    if (reloadedPersisted === null || reloadedPersisted.status !== 'locked') {
      throw new Error(`刷新后 PendingAction.status 应为 locked，实际 ${reloadedPersisted?.status ?? '(行不存在)'}`);
    }
    const reloadedPending = await fetchPendingActions(baseUrl);
    if (reloadedPending.some((action) => action.id === actionId)) {
      throw new Error('刷新后 GET /api/actions 又重新把已锁定操作当待处理项');
    }
    const reloadedBody = await visibleBodyText(page);
    throwOnLeak(scan(reloadedBody, DOM_FORBIDDEN, '刷新后全页可见文本'), reloadedBody);
    await shoot('lH-after-reload');

    // --- (e) security centre -----------------------------------------------------------------
    await page.goto(`${baseUrl}/security`, { waitUntil: 'domcontentloaded' });
    const unlockPanel = page.locator(`${SELECTORS.unlockPanel}[data-unlock-locked="true"]`).first();
    await unlockPanel.waitFor({ state: 'visible', timeout: 90_000 });
    const panelAttrs = {
      locked: await unlockPanel.getAttribute('data-unlock-locked'),
      failures: await unlockPanel.getAttribute('data-unlock-failures'),
      maxAttempts: await unlockPanel.getAttribute('data-unlock-max-attempts'),
      lockedActions: await unlockPanel.getAttribute('data-unlock-locked-actions'),
    };
    if (panelAttrs.locked !== 'true') throw new Error(`解锁面板 data-unlock-locked 应为 true，实际 ${String(panelAttrs.locked)}`);
    if (panelAttrs.failures !== String(MAX_ATTEMPTS)) {
      throw new Error(`解锁面板 data-unlock-failures 应为 ${MAX_ATTEMPTS}，实际 ${String(panelAttrs.failures)}`);
    }
    if (panelAttrs.maxAttempts !== String(MAX_ATTEMPTS)) {
      throw new Error(`解锁面板 data-unlock-max-attempts 应为 ${MAX_ATTEMPTS}，实际 ${String(panelAttrs.maxAttempts)}`);
    }

    const securityBody = await visibleBodyText(page);
    const expectedCopies = {
      lockReason: t('security.reset.lockReason', { count: MAX_ATTEMPTS, max: MAX_ATTEMPTS }),
      lockedActionState: t('security.reset.lockedActionState'),
      reinitiate: t('security.reset.reinitiate'),
      recovery: t('security.reset.recovery'),
      unlock: t('security.reset.unlock'),
      breakerLocked: t('security.breaker.locked'),
      failureCount: t('security.breaker.failureCount', { count: MAX_ATTEMPTS, max: MAX_ATTEMPTS }),
      actionLocked: t('chat.error.actionLocked'),
    };
    const missingCopy = Object.entries(expectedCopies)
      .filter(([, value]) => !securityBody.includes(collapse(value)))
      .map(([key, value]) => `${key}=「${collapse(value)}」`);
    if (missingCopy.length > 0) {
      throw new Error(`安全中心缺少文案：${missingCopy.join('；')}｜ 页面文本尾部：${securityBody.slice(-500)}`);
    }

    const lockReasonBlock = page.locator('[data-lock-reason="CIRCUIT_BREAKER_TRIPPED"]').first();
    const lockReasonCount = await lockReasonBlock.count();
    if (lockReasonCount === 0) throw new Error('安全中心缺少 [data-lock-reason="CIRCUIT_BREAKER_TRIPPED"] 区块');
    const lockReasonText = collapse((await lockReasonBlock.innerText().catch(() => '')) ?? '');

    const lockedActionRows = await page.locator('section[data-locked-actions] li[data-locked-action-id]').count();
    const lockedActionIds = await page.locator('section[data-locked-actions] li[data-locked-action-id]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('data-locked-action-id') ?? ''),
    );
    if (lockedActionRows === 0) throw new Error('安全中心未列出锁定操作（section[data-locked-actions] li）');
    if (!lockedActionIds.includes(actionId)) {
      throw new Error(`安全中心锁定操作列表不含本次 actionId ${actionId}（实际 ${lockedActionIds.join('、')}）`);
    }
    if (panelAttrs.lockedActions !== String(lockedActionRows)) {
      throw new Error(
        `解锁面板 data-unlock-locked-actions=${String(panelAttrs.lockedActions)} 与页面列出的 ${lockedActionRows} 条锁定操作不一致`,
      );
    }

    const trippedEventRows = await page.locator('[data-security-event-kind="CIRCUIT_BREAKER_TRIPPED"]').count();
    if (trippedEventRows === 0) {
      throw new Error('安全中心事件列表缺少 [data-security-event-kind="CIRCUIT_BREAKER_TRIPPED"]');
    }
    throwOnLeak(scan(securityBody, DOM_FORBIDDEN, '安全中心全页可见文本'), securityBody);

    const security = await getJson<{
      circuitBreaker: { failures: number; max: number; locked: boolean };
      lock?: { code: string; reason: string };
      lockedActions: { actionId: string; toolName: string }[];
    }>(`${baseUrl}/api/security`);
    if (security.circuitBreaker.locked !== true) {
      throw new Error(`GET /api/security circuitBreaker.locked 应为 true，实际 ${String(security.circuitBreaker.locked)}`);
    }
    if (security.circuitBreaker.failures !== MAX_ATTEMPTS) {
      throw new Error(`GET /api/security circuitBreaker.failures 应为 ${MAX_ATTEMPTS}，实际 ${security.circuitBreaker.failures}`);
    }
    if (security.lock === undefined) throw new Error('GET /api/security 未给出 lock（熔断原因）');
    if (security.lock.code !== 'CIRCUIT_OPEN') {
      throw new Error(`GET /api/security lock.code 应为 CIRCUIT_OPEN，实际 ${security.lock.code}`);
    }
    if (!security.lockedActions.some((action) => action.actionId === actionId)) {
      throw new Error(`GET /api/security lockedActions 不含 ${actionId}（实际 ${security.lockedActions.map((a) => a.actionId).join('、')}）`);
    }
    await shoot('lH-security-center');

    // --- persisted audit facts ----------------------------------------------------------------
    const securityEvents = await querySecurityEvents({ sessionId });
    const failureEvents = securityEvents.filter((event) => event.kind === 'MFA_FAILURE');
    const trippedEvents = securityEvents.filter((event) => event.kind === 'CIRCUIT_BREAKER_TRIPPED');
    if (failureEvents.length < MAX_ATTEMPTS) {
      throw new Error(`SecurityEvent MFA_FAILURE 应有 ≥ ${MAX_ATTEMPTS} 条，实际 ${failureEvents.length}`);
    }
    if (trippedEvents.length !== 1) {
      throw new Error(`SecurityEvent CIRCUIT_BREAKER_TRIPPED 应恰 1 条，实际 ${trippedEvents.length}`);
    }

    // ------------------------------------------------------------------------------------------
    const evidence = {
      actionId,
      dockKind,
      sessionId,
      nudges,
      confirmFirst,
      wrongCode: WRONG_CODE,
      attempts: attempts.map((record) => ({
        attempt: record.attempt,
        httpStatus: 200,
        status: record.status,
        code: record.code,
        mfaResult: record.mfaResult,
        failure: record.failure,
        attemptsLeft: record.attemptsLeft,
        maxAttempts: record.maxAttempts,
        counterLine: record.counterLine,
        dockText: record.dockText,
        statusTexts: record.statusTexts,
        serverMessageInternal: record.message,
      })),
      verifyBodies: verifyCalls.map((call) => ({ actionId: call.actionId, httpStatus: call.httpStatus, body: call.body })),
      db: {
        pendingAction: dbFacts.action === null ? null : { ...dbFacts.action, updatedAt: dbFacts.action.updatedAt.toISOString() },
        mfaChallenge: dbFacts.challenge === null ? null : {
          ...dbFacts.challenge,
          verifiedAt: dbFacts.challenge.verifiedAt?.toISOString() ?? null,
          consumedAt: dbFacts.challenge.consumedAt?.toISOString() ?? null,
          expiresAt: dbFacts.challenge.expiresAt?.toISOString() ?? null,
        },
        circuitBreaker: dbFacts.breaker === null ? null : {
          ...dbFacts.breaker,
          lockedAt: dbFacts.breaker.lockedAt?.toISOString() ?? null,
          updatedAt: dbFacts.breaker.updatedAt.toISOString(),
        },
      },
      securityEvents: securityEvents.slice(0, 12).map((event) => ({ kind: event.kind, severity: event.severity, message: event.message })),
      securityReadModel: security,
      dom: {
        markerChecks,
        leakHits: markerChecks.filter((check) => check.found).length,
        zeroAttemptsCopyHits: zeroHits.length,
        retryCopyPresent,
        dockBadgeCopy,
      },
      reload: {
        lockedReceipts: reloadedLockedReceipts,
        lockedStages: reloadedStages,
        mfaInputs: reloadedInputs,
        dockCount: reloadedDock,
        confirmButtons: reloadedConfirm,
        verifyButtons: reloadedVerify,
        statusTexts: reloadedStatusTexts,
      },
      securityCentre: { panelAttrs, lockReasonText, lockedActionIds, trippedEventRows, textTail: securityBody.slice(-600) },
      shots,
    };
    const evidencePath = writeScenarioEvidence('lH-mfa-lock', evidence);

    // ---- ONE evidence string -------------------------------------------------------------------
    const firstCopy = first.counterLine;
    const secondCopy = second.counterLine;
    const lockedCopy = third.counterLine === ''
      ? lockedStatusTexts.find((text) => text.includes(lockedBadgeCopy)) ?? lockedBadgeCopy
      : third.counterLine;
    return [
      `停泊 actionId=${actionId}（kind=${String(dockKind)}，自然轮次 ${nudges.length}，确认卡前置=${confirmFirst ? '是' : '否'}）`,
      `(a) 第1次「${firstCopy}」failure=${JSON.stringify(first.failure)} attemptsLeft=${String(first.attemptsLeft)}/${String(first.maxAttempts)}`,
      `(a) 第2次「${secondCopy}」failure=${JSON.stringify(second.failure)} attemptsLeft=${String(second.attemptsLeft)}/${String(second.maxAttempts)}`,
      `(a) 第3次「${lockedCopy}」status=${third.status} code=${third.code} failure=${JSON.stringify(third.failure)} attemptsLeft=${String(third.attemptsLeft)}`,
      `(a-extra) 「还可尝试0次」误渲染命中=${zeroHits.length}，可重试文案出现=${retryCopyPresent.length}，停泊区徽章兜底句「${dockBadgeCopy}」，服务端 attemptsLeft 直传 2/1/0 正确`,
      `(b) 验证码输入框=${mfaInputsAfterLock}、mfaCardPresent=${String(await mfaCardPresent(page))}、停泊区=${dockAfterLock}；PendingAction.status=${persisted.status}、resultJson=${persisted.resultJson === null ? 'null' : '非空'}；GET /api/actions 不再含该 id；MfaChallenge attempts=${dbFacts.challenge.attempts}/max=${dbFacts.challenge.maxAttempts}/status=${dbFacts.challenge.status}；CircuitBreaker key=${dbFacts.breaker.key} failures=${dbFacts.breaker.failures}/locked=${String(dbFacts.breaker.locked)}`,
      `(c) 内部标记检查 ${markerChecks.length} 项（DOM ${DOM_FORBIDDEN.length} 类 × ${domTextsByAttempt.length} 个文本面 + verify JSON ${JSON_FORBIDDEN.length} 类 × ${verifyCalls.length} 次）全部未命中（__SECURITY_BLOCK__/decisionKind/"code":"/{\\"/Error:/堆栈帧），账本新增 ${ledgerDiff.added.length} 条`,
      `(d) 刷新后 锁定回执=${reloadedLockedReceipts}、当前阶段=${reloadedStages}、验证码输入框=${reloadedInputs}、停泊区=${reloadedDock}、确认按钮=${reloadedConfirm}、验证按钮=${reloadedVerify}、PendingAction.status=${reloadedPersisted?.status ?? '(缺)'}`,
      `(e) /security [data-unlock-locked=${String(panelAttrs.locked)}][data-unlock-failures=${String(panelAttrs.failures)}][data-unlock-max-attempts=${String(panelAttrs.maxAttempts)}][data-unlock-locked-actions=${String(panelAttrs.lockedActions)}]；锁定原因「${expectedCopies.lockReason}」；操作状态「${expectedCopies.lockedActionState}」；恢复方式「${expectedCopies.recovery}」；[data-lock-reason] = 「${lockReasonText.slice(0, 160)}」；锁定操作行 ${lockedActionRows} 条含 ${actionId}；CIRCUIT_BREAKER_TRIPPED 事件行 ${trippedEventRows} 条；GET /api/security lock.code=${security.lock.code} failures=${security.circuitBreaker.failures} locked=${String(security.circuitBreaker.locked)}`,
      `DB 审计：MFA_FAILURE ${failureEvents.length} 条、CIRCUIT_BREAKER_TRIPPED ${trippedEvents.length} 条`,
      `证据 JSON=${evidencePath ?? '(未写出)'}；截图 ${shots.length} 张`,
    ].join(' ｜ ');
  } finally {
    page.off('response', onResponse);
  }
}
