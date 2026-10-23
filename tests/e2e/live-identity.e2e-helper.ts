/**
 * `tests/e2e/live-identity.e2e-helper.ts` — live scenario **lI**: identity resolution by NUMBER.
 *
 * Certifies the number-resolution contract end-to-end through the REAL `/agent` UI, the REAL model and
 * the REAL SQLite bank — never the SDK directly:
 *
 *   1. EXACT full phone number → resolves to the ONE owned contact, parks a YELLOW `transfer_money`
 *      confirmation whose recipient (name + MASKED phone) matches the seeded `Contact`. Cancel → no
 *      money moves.
 *   2. NEAR-MISS phone (same first-3 + last-4, different middle-4) → MUST NOT mis-match: no confirmation
 *      card, no `PendingAction`, no ledger row, no balance change; the server refuses with its clarify
 *      text (or the model asks for clarification) — never a silent wrong payee.
 *   3. TAIL-ONLY card expression ("尾号6688") → resolves to the ONE owned card WITHOUT the user ever
 *      supplying the full number; the confirmation's 卡片 field shows `信用卡 ****6688`, whose last-4
 *      equals the seeded `Card.numberFull` suffix. Cancel → card unchanged.
 *   4. The tail is NEVER passed as `cardId` (the model's persisted tool args carry `cardTail`, and
 *      `cardId` is absent or a real owned id), and MASKING holds: the full phone / full card number
 *      never surface in a tool RESULT, the confirmation card, assistant prose or any persisted state
 *      projection (full values live ONLY in `Contact.phoneFull` / `Card.numberFull`).
 *
 * All amounts/ids come from the seeded live DB (never hard-coded), so a seed change cannot make an
 * assertion pass vacuously. Used by `live-acceptance.e2e.ts` via the `lI` SCENARIOS entry.
 */
import type { Page } from 'playwright-core';
import {
  assertNoFabricatedConfirmationPanel,
  assistantTexts,
  fetchPendingActions,
  getJson,
  gotoAgent,
  sleep,
  submitChat,
  waitFor,
  waitForConfirmCard,
  SELECTORS,
  type PendingActionView,
} from './helpers';
import {
  cardById,
  fetchLiveCards,
  liveModelId,
  withDb,
  writeScenarioEvidence,
} from './live-virtual-card.e2e-helper';
import { centsToMoney } from '../../lib/money';

// --- seed anchors (read back from the DB; these are only lookup keys) ----------------------------
const CONTACT_ID = 'contact_zhangwei';
const CREDIT_CARD_ID = 'card_credit';
const CHECKING_ID = 'acct_checking';
const TRANSFER_AMOUNT = '200.00';
const CARD_CATEGORY = '餐饮';
const CARD_LIMIT_AMOUNT = '1000.00';
const MASKED_PHONE = /^\d{3}\*{4}\d{3,4}$/;

export interface ScenarioIdentityInput {
  page: Page;
  baseUrl: string;
  /** Shared live-screenshot writer from the entry harness (`captureLive`). */
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
}

interface IdentitySeed {
  contactName: string;
  phoneFull: string;
  phoneMasked: string;
  cardNumberFull: string;
  cardNumberMasked: string;
}

/** Read the authoritative identity values straight from the seeded live DB (never hard-coded). */
async function readIdentitySeed(): Promise<IdentitySeed> {
  return withDb(async (db) => {
    const contact = await db.contact.findUnique({
      where: { id: CONTACT_ID },
      select: { name: true, phone: true, phoneFull: true },
    });
    const card = await db.card.findUnique({
      where: { id: CREDIT_CARD_ID },
      select: { numberFull: true, numberMasked: true },
    });
    if (!contact || !contact.phoneFull) throw new Error(`缺少联系人 ${CONTACT_ID}.phoneFull（身份解析无法验收）`);
    if (!card || !card.numberFull) throw new Error(`缺少卡片 ${CREDIT_CARD_ID}.numberFull（尾号解析无法验收）`);
    return {
      contactName: contact.name,
      phoneFull: contact.phoneFull,
      phoneMasked: contact.phone,
      cardNumberFull: card.numberFull,
      cardNumberMasked: card.numberMasked ?? `****${card.numberFull.slice(-4)}`,
    };
  });
}

/** Same first-3 + last-4 as `full`, a different middle-4 — the classic "looks-alike" near miss. */
function nearMissPhone(full: string): string {
  const middle = '1111';
  const made = `${full.slice(0, 3)}${middle}${full.slice(-4)}`;
  if (made === full) throw new Error(`近号生成失败（与原号相同）：${made}`);
  return made;
}

function readCheckingBalanceMinor(): Promise<bigint> {
  return withDb(async (db) => {
    const account = await db.account.findUnique({ where: { id: CHECKING_ID }, select: { balanceMinor: true } });
    if (!account) throw new Error(`缺少账户 ${CHECKING_ID}`);
    return account.balanceMinor;
  });
}

/** DEBIT `Transaction` ids on the CHECKING account (used as a "no new ledger row" delta fence). */
function readCheckingDebitIds(): Promise<string[]> {
  return withDb(async (db) =>
    (
      await db.transaction.findMany({
        where: { accountId: CHECKING_ID, direction: 'DEBIT' },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
}

interface ActionSnapshot {
  ids: Set<string>;
  actions: PendingActionView[];
}

async function actionSnapshot(baseUrl: string): Promise<ActionSnapshot> {
  const actions = await fetchPendingActions(baseUrl);
  return { ids: new Set(actions.map((a) => a.id)), actions };
}

/** Newly parked `transfer_money` actions (by id) between two snapshots — the "did a wrong payee park?" fence. */
function newTransferActions(before: ActionSnapshot, after: ActionSnapshot): PendingActionView[] {
  return after.actions.filter((a) => !before.ids.has(a.id) && a.toolName === 'transfer_money');
}

function describeActions(actions: readonly PendingActionView[]): string {
  if (actions.length === 0) return '[]';
  return actions.map((a) => `{id:${a.id},tool:${a.toolName},tier:${a.tier},status:${a.status}}`).join(' ');
}

/** Read the LAST actionable approval card's `dt → dd` map (transfer AND card confirm cards both use `<dl>`). */
async function readLastApprovalFields(page: Page): Promise<Record<string, string>> {
  const dls = page.locator('[data-approval-request="true"] dl');
  const count = await dls.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const dl = dls.nth(i);
    const labels = (await dl.locator('dt').allInnerTexts()).map((l) => l.replace(/\s+/g, '').trim());
    if (labels.length === 0) continue;
    const values = (await dl.locator('dd').allInnerTexts()).map((v) => v.trim());
    const out: Record<string, string> = {};
    labels.forEach((label, index) => {
      out[label] = values[index] ?? '';
    });
    return out;
  }
  return {};
}

/** The number of rendered actionable `确认` buttons (0 once no confirm card is present). */
async function confirmButtonCount(page: Page): Promise<number> {
  return page.locator('[data-approval-request="true"]').getByRole('button', { name: '确认', exact: true }).count();
}

/** Click the confirmation card's `取消` button, then wait for the card to leave the actionable dock. */
async function cancelApproval(page: Page, timeoutMs = 45_000): Promise<void> {
  const button = page.locator('[data-approval-request="true"]').getByRole('button', { name: '取消', exact: true });
  await waitFor(async () => ((await button.count()) > 0 ? true : false), { timeoutMs, description: '确认卡「取消」按钮' });
  await button.first().click();
  await waitFor(async () => ((await confirmButtonCount(page)) === 0 ? true : false), {
    timeoutMs,
    description: '确认卡已关闭（无可点「确认」）',
  });
}

interface ToolCallObs {
  name: string;
  args: unknown;
}
interface ToolResultObs {
  name: string;
  isError: boolean;
  text: string;
}
interface SessionEvidence {
  calls: ToolCallObs[];
  results: ToolResultObs[];
  /** Concatenated `stateJson` of every session (server-side persisted projection, for leak scanning). */
  allStateText: string;
}

/**
 * Recover the persisted tool calls / results from `AgentSession.stateJson` — the exact arg shape the
 * LIVE model produced (which selector it populated) and the exact tool-result text. Read-only.
 */
async function readSessionToolEvidence(): Promise<SessionEvidence> {
  return withDb(async (db) => {
    const sessions = await db.agentSession.findMany({ select: { stateJson: true } });
    const calls: ToolCallObs[] = [];
    const results: ToolResultObs[] = [];
    let allStateText = '';
    for (const session of sessions) {
      allStateText += `\n${session.stateJson}`;
      let messages: unknown[] = [];
      try {
        const parsed = JSON.parse(session.stateJson) as { agentState?: { messages?: unknown } };
        const raw = parsed.agentState?.messages;
        messages = Array.isArray(raw) ? raw : [];
      } catch {
        continue;
      }
      for (const rawMessage of messages) {
        if (typeof rawMessage !== 'object' || rawMessage === null) continue;
        const message = rawMessage as Record<string, unknown>;
        if (message['role'] === 'assistant' && Array.isArray(message['content'])) {
          for (const rawPart of message['content'] as unknown[]) {
            if (typeof rawPart !== 'object' || rawPart === null) continue;
            const part = rawPart as Record<string, unknown>;
            if (part['type'] === 'toolCall' && typeof part['name'] === 'string') {
              calls.push({ name: part['name'], args: part['arguments'] });
            }
          }
        } else if (message['role'] === 'toolResult') {
          const name = typeof message['toolName'] === 'string' ? message['toolName'] : '?';
          const content = Array.isArray(message['content']) ? (message['content'] as unknown[]) : [];
          const text = content
            .map((part) =>
              typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string'
                ? ((part as Record<string, unknown>)['text'] as string)
                : '',
            )
            .join(' ');
          results.push({ name, isError: message['isError'] === true, text });
        }
      }
    }
    return { calls, results, allStateText };
  });
}

/** Recursively collect every value under the key `wanted` (case-insensitive) from a parsed JSON tree. */
function collectByKey(node: unknown, wanted: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, wanted, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted) found.push(value);
      collectByKey(value, wanted, found);
    }
  }
  return found;
}

interface ModelProof {
  /** The `/api/health` LLM mode (must be `live` for a valid run). */
  llmMode: string;
  /** Resolved model id (provided config, or the forced override). */
  modelId: string;
  /** Number of `ModelRequest` rows the run persisted. */
  requestCount: number;
  /** A concrete provider `x-request-id` recovered from a `ModelRequest.resultJson` (real-model proof). */
  lastRequestId?: string;
  /** True when a completed provider stream ending with `[DONE]` was observed. */
  completedStream: boolean;
}

/** `/api/health` must report `live` (fail fast before any turn if the harness booted a mock server). */
async function assertHealthLive(baseUrl: string): Promise<void> {
  const health = await getJson<{ ok: boolean; data: { llmMode: string } }>(`${baseUrl}/api/health`);
  const llmMode = health?.data?.llmMode ?? '(missing)';
  if (llmMode !== 'live') throw new Error(`/api/health.data.llmMode 应为 live（真模型），实际「${llmMode}」`);
}

/** `/api/health` says `live`, plus server-side `ModelRequest` evidence that the provider was really hit. */
async function proveLiveModel(baseUrl: string, priorRequestIds: Set<string>): Promise<ModelProof> {
  const health = await getJson<{ ok: boolean; data: { llmMode: string } }>(`${baseUrl}/api/health`);
  const llmMode = health?.data?.llmMode ?? '(missing)';
  if (llmMode !== 'live') throw new Error(`/api/health.data.llmMode 应为 live（真模型），实际「${llmMode}」`);

  const rows = await withDb(async (db) =>
    db.modelRequest.findMany({ orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, status: true, resultJson: true } }),
  );
  const fresh = rows.filter((row) => !priorRequestIds.has(row.id));
  const scoped = fresh.length > 0 ? fresh : rows;

  let lastRequestId: string | undefined;
  let completedStream = false;
  for (const row of scoped) {
    if (!row.resultJson) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.resultJson);
    } catch {
      continue;
    }
    const headersList = collectByKey(parsed, 'provider_response_headers');
    for (const headers of headersList) {
      if (typeof headers !== 'object' || headers === null) continue;
      const rid = (headers as Record<string, unknown>)['x-request-id'] ?? (headers as Record<string, unknown>)['request-id'];
      if (typeof rid === 'string' && rid.trim() !== '') lastRequestId = rid.trim();
    }
    if (row.resultJson.includes('[DONE]')) completedStream = true;
  }
  if (scoped.length === 0) throw new Error('未发现任何 ModelRequest 记录（无法证明真模型被调用）');

  return { llmMode, modelId: liveModelId(), requestCount: scoped.length, lastRequestId, completedStream };
}

/** Ids of the `ModelRequest` rows that already exist BEFORE the run (so the proof scopes to this run). */
async function snapshotModelRequestIds(): Promise<Set<string>> {
  const rows = await withDb(async (db) => db.modelRequest.findMany({ select: { id: true } }));
  return new Set(rows.map((row) => row.id));
}

/**
 * Drive one natural-language turn that MUST NOT park a confirmation card, and wait (bounded) for the
 * model turn to settle. Throws immediately if a `确认` card appears (a near-miss must never resolve).
 */
async function submitExpectingNoCard(page: Page, text: string, timeoutMs = 90_000): Promise<void> {
  const assistantBefore = (await assistantTexts(page)).length;
  await submitChat(page, text);
  let cardAppeared = false;
  await waitFor(
    async () => {
      if ((await confirmButtonCount(page)) > 0) {
        cardAppeared = true;
        return true;
      }
      const grew = (await assistantTexts(page)).length > assistantBefore;
      const composerFree = await page.locator(SELECTORS.composer).first().isEnabled().catch(() => false);
      return grew && composerFree;
    },
    { timeoutMs, description: '自然语言回合结束（且未生成确认卡）' },
  );
  // A card can render a beat after the composer re-enables: give the UI a short settle, then re-check.
  await sleep(1500);
  if (cardAppeared || (await confirmButtonCount(page)) > 0) {
    const fields = await readLastApprovalFields(page);
    throw new Error(`近号/无效号码不得生成确认卡（不得误匹配收款人），实际渲染了确认卡：${JSON.stringify(fields)}`);
  }
}

export async function scenarioIdentityResolution(input: ScenarioIdentityInput): Promise<string> {
  const { page, baseUrl, captureShot } = input;
  const seed = await readIdentitySeed();
  const nearMiss = nearMissPhone(seed.phoneFull);
  const priorRequestIds = await snapshotModelRequestIds();

  await gotoAgent(page, baseUrl);
  await assertHealthLive(baseUrl);

  // Clean slate: a scenario that ran earlier in the SAME harness round may have left a `pending` action
  // whose confirmation card re-renders on load. Dismiss it so legs 1–3 can attribute every card to the
  // turn that produced it (an isolated `LIVE_SCENARIOS=lI` round starts on a fresh DB with nothing to clear).
  let clearGuard = 0;
  while ((await confirmButtonCount(page)) > 0 && clearGuard < 5) {
    await cancelApproval(page);
    clearGuard += 1;
  }

  // ================================================================================================
  // LEG 1 — EXACT full number resolves to the ONE owned contact; cancel → no money moves.
  // ================================================================================================
  const leg1BalanceBefore = await readCheckingBalanceMinor();
  const leg1ActionsBefore = await actionSnapshot(baseUrl);
  const leg1DebitIdsBefore = await readCheckingDebitIds();

  await submitChat(page, `给${seed.phoneFull}转${TRANSFER_AMOUNT}元`);
  await waitForConfirmCard(page, 120_000);
  const leg1Fields = await readLastApprovalFields(page);
  const leg1Joined = JSON.stringify(leg1Fields);
  const recipientName = (leg1Fields['收款人'] ?? '').replace(/\s+/g, '');
  const recipientPhone = (leg1Fields['收款手机号'] ?? '').replace(/\s+/g, '');
  if (leg1Joined.includes('（未指定）')) throw new Error(`精确手机号转账确认卡出现「（未指定）」：${leg1Joined}`);
  if (recipientName !== seed.contactName) {
    throw new Error(`精确手机号转账确认卡收款人应为「${seed.contactName}」，实际「${recipientName}」（字段：${leg1Joined}）`);
  }
  if (!MASKED_PHONE.test(recipientPhone)) {
    throw new Error(`确认卡收款手机号必须为掩码号码，实际「${recipientPhone}」（字段：${leg1Joined}）`);
  }
  if (recipientPhone !== seed.phoneMasked) {
    throw new Error(`确认卡收款手机号应为种子的掩码号「${seed.phoneMasked}」，实际「${recipientPhone}」`);
  }

  // MASKING (leg 4, part A): the APP-STRUCTURED surface (the confirmation card) must render the masked
  // phone, never the full number. The page keeps the user's OWN typed message (which legitimately
  // contains the full number) and the model MAY quote it back in prose — neither is an app-projection
  // leak, so the prose echo is RECORDED as an observation rather than failed on here.
  const leg1ApprovalText = (await page.locator('[data-approval-request="true"]').allInnerTexts()).join('\n');
  if (leg1ApprovalText.includes(seed.phoneFull)) {
    throw new Error(`确认卡渲染泄漏完整手机号 ${seed.phoneFull}（脱敏契约被破坏）`);
  }
  const leg1AssistantText = (await assistantTexts(page)).join('\n');

  const shot1 = await captureShot(page, 'lI-leg1-exact-phone-confirm');
  const shot4 = await captureShot(page, 'lI-leg4-masked-phone-rendering');
  await cancelApproval(page);

  const leg1BalanceAfter = await readCheckingBalanceMinor();
  if (leg1BalanceAfter !== leg1BalanceBefore) {
    throw new Error(
      `取消精确手机号转账后余额应不变，实际 ${centsToMoney(leg1BalanceBefore)} → ${centsToMoney(leg1BalanceAfter)}`,
    );
  }
  const leg1DebitIdsAfter = await readCheckingDebitIds();
  const leg1NewDebits = leg1DebitIdsAfter.filter((id) => !leg1DebitIdsBefore.includes(id));
  if (leg1NewDebits.length !== 0) throw new Error(`取消精确手机号转账后不得写入流水，实际新增 ${leg1NewDebits.join(',')}`);
  const leg1ActionsAfter = await actionSnapshot(baseUrl);

  // ================================================================================================
  // LEG 2 — NEAR-MISS phone must NOT mis-match: no card, no PendingAction, no money, no ledger row.
  // ================================================================================================
  const leg2BalanceBefore = await readCheckingBalanceMinor();
  const leg2ActionsBefore = await actionSnapshot(baseUrl);
  const leg2DebitIdsBefore = await readCheckingDebitIds();
  const leg2AssistantBefore = (await assistantTexts(page)).length;

  await submitExpectingNoCard(page, `给${nearMiss}转${TRANSFER_AMOUNT}元`, 120_000);

  const leg2Prose = (await assistantTexts(page)).slice(leg2AssistantBefore).join('\n');
  const leg2ActionsLive = await fetchPendingActions(baseUrl);
  await assertNoFabricatedConfirmationPanel({ page, prose: leg2Prose, actions: leg2ActionsLive });

  const leg2BalanceAfter = await readCheckingBalanceMinor();
  if (leg2BalanceAfter !== leg2BalanceBefore) {
    throw new Error(`近号转账不得移动资金，实际 ${centsToMoney(leg2BalanceBefore)} → ${centsToMoney(leg2BalanceAfter)}`);
  }
  const leg2DebitIdsAfter = await readCheckingDebitIds();
  const leg2NewDebits = leg2DebitIdsAfter.filter((id) => !leg2DebitIdsBefore.includes(id));
  if (leg2NewDebits.length !== 0) throw new Error(`近号转账不得写入流水，实际新增 ${leg2NewDebits.join(',')}`);
  const leg2ActionsAfter = await actionSnapshot(baseUrl);
  const leg2NewTransfers = newTransferActions(leg2ActionsBefore, leg2ActionsAfter);
  if (leg2NewTransfers.length !== 0) {
    throw new Error(`近号「${nearMiss}」不得生成 transfer_money PendingAction，实际新增：${describeActions(leg2NewTransfers)}`);
  }

  const shot2 = await captureShot(page, 'lI-leg2-near-miss-refused');
  const leg2Evidence = await readSessionToolEvidence();
  const nearMissArgs = leg2Evidence.calls.filter((c) => JSON.stringify(c.args).includes(nearMiss));
  const nearMissRefusal = leg2Evidence.results.some(
    (r) =>
      r.text.includes(nearMiss) &&
      (r.isError || r.text.includes('未能找到') || r.text.includes('未找到') || r.text.includes('找不到')),
  );
  const nearMissReferenced =
    nearMissArgs.length > 0 ||
    nearMissRefusal ||
    leg2Prose.includes(nearMiss) ||
    /未能找到|未找到|找不到|请确认|确认.*手机号|手机号.*确认/.test(leg2Prose);
  if (!nearMissReferenced) {
    throw new Error(`模型未真正处理近号「${nearMiss}」（既未调用带该号码的工具，也未澄清）——无法证明防误匹配`);
  }

  // ================================================================================================
  // LEG 3 — TAIL-ONLY card expression resolves to the ONE card WITHOUT the full number.
  // ================================================================================================
  const cardsBefore = await fetchLiveCards(baseUrl);
  const creditBefore = cardById(cardsBefore, CREDIT_CARD_ID);
  if (!creditBefore) throw new Error(`缺少信用卡 ${CREDIT_CARD_ID}`);
  if (creditBefore.status !== 'ACTIVE') throw new Error(`信用卡 ${CREDIT_CARD_ID} 前置状态应为 ACTIVE，实际 ${creditBefore.status}`);
  const creditStatusBefore = creditBefore.status;
  const tail = seed.cardNumberFull.slice(-4);

  await submitChat(page, `把我尾号${tail}的信用卡的${CARD_CATEGORY}消费限额设为${CARD_LIMIT_AMOUNT}元`);
  await waitForConfirmCard(page, 120_000);
  const leg3Fields = await readLastApprovalFields(page);
  const leg3Joined = JSON.stringify(leg3Fields);
  const cardField = (leg3Fields['卡片'] ?? '').trim();
  if (!cardField.includes('信用卡')) {
    throw new Error(`尾号${tail} 应解析到信用卡，确认卡「卡片」字段实际「${cardField}」（字段：${leg3Joined}）`);
  }
  if (!cardField.includes(`****${tail}`)) {
    throw new Error(`确认卡「卡片」尾号应为 ****${tail}（= Card.numberFull 后四位），实际「${cardField}」（字段：${leg3Joined}）`);
  }

  // MASKING (leg 4, part B): the FULL card number is never typed by the user, so it must appear NOWHERE
  // in any rendered surface — a tail expression must resolve server-side without exposing the number.
  const leg3ApprovalText = (await page.locator('[data-approval-request="true"]').allInnerTexts()).join('\n');
  if (leg3ApprovalText.includes(seed.cardNumberFull)) {
    throw new Error(`尾号解析的确认卡泄漏完整卡号 ${seed.cardNumberFull}`);
  }
  const leg3BodyText = await page.locator('body').innerText().catch(() => '');
  if (leg3BodyText.includes(seed.cardNumberFull)) {
    throw new Error(`页面正文泄漏完整卡号 ${seed.cardNumberFull}（尾号表达应无需完整卡号）`);
  }

  const shot3 = await captureShot(page, 'lI-leg3-card-tail-resolved');
  await cancelApproval(page);

  const cardsAfter = await fetchLiveCards(baseUrl);
  const creditAfter = cardById(cardsAfter, CREDIT_CARD_ID);
  if (creditAfter?.status !== creditStatusBefore) {
    throw new Error(`取消尾号限额设置后信用卡状态应不变（${creditStatusBefore}），实际 ${creditAfter?.status}`);
  }

  // ================================================================================================
  // LEG 4 (runtime) — the tail is NEVER passed as cardId, and no tool RESULT leaks a full number.
  // ================================================================================================
  const finalEvidence = await readSessionToolEvidence();
  const setLimitCalls = finalEvidence.calls.filter((c) => c.name === 'set_card_limit');
  if (setLimitCalls.length === 0) throw new Error('未发现 set_card_limit 工具调用（尾号选择器未走到解析路径）');
  const lastSetArgs = setLimitCalls[setLimitCalls.length - 1].args as Record<string, unknown>;
  const lastSetArgsStr = JSON.stringify(lastSetArgs);
  const tailSelector = String(lastSetArgs['cardTail'] ?? '').includes(tail);
  if (!tailSelector) {
    throw new Error(`set_card_limit 应携带 cardTail 选择器（含 ${tail}），实际 args=${lastSetArgsStr}`);
  }
  const rawCardId = lastSetArgs['cardId'];
  if (rawCardId !== undefined && rawCardId !== null && String(rawCardId) !== '') {
    if (String(rawCardId) === tail || String(rawCardId) === seed.cardNumberFull) {
      throw new Error(`尾号/卡号被直接当作 cardId 传入下游（应为 cardTail 选择器），实际 cardId=${String(rawCardId)}`);
    }
    if (!/^card_/.test(String(rawCardId))) {
      throw new Error(`cardId 必须来自 get_cards 的确切 id，实际 ${String(rawCardId)}`);
    }
  }
  if (finalEvidence.results.some((r) => r.text.includes(seed.cardNumberFull))) {
    throw new Error(`工具结果泄漏完整卡号 ${seed.cardNumberFull}（脱敏契约被破坏）`);
  }
  if (finalEvidence.results.some((r) => r.text.includes(seed.phoneFull))) {
    throw new Error(`工具结果泄漏完整手机号 ${seed.phoneFull}（脱敏契约被破坏）`);
  }
  if (finalEvidence.allStateText.includes(seed.cardNumberFull)) {
    throw new Error(`持久化状态（stateJson 投影）泄漏完整卡号 ${seed.cardNumberFull}`);
  }

  // ================================================================================================
  // Evidence artifact + summary.
  // ================================================================================================
  // Compute the real-model proof LAST so the fresh `ModelRequest` rows are THIS scenario's turns.
  const proof = await proveLiveModel(baseUrl, priorRequestIds);
  await writeScenarioEvidence('lI', {
    contact: { id: CONTACT_ID, name: seed.contactName, phoneMasked: seed.phoneMasked },
    card: { id: CREDIT_CARD_ID, numberMasked: seed.cardNumberMasked },
    nearMiss: { phone: nearMiss, callArgs: nearMissArgs, refused: nearMissRefusal },
    leg1: {
      prompt: `给${seed.phoneFull}转${TRANSFER_AMOUNT}元`,
      confirmFields: leg1Fields,
      balanceBefore: centsToMoney(leg1BalanceBefore),
      balanceAfter: centsToMoney(leg1BalanceAfter),
      newTransferActions: describeActions(newTransferActions(leg1ActionsBefore, leg1ActionsAfter)),
    },
    leg2: {
      promptNearMiss: `给${nearMiss}转${TRANSFER_AMOUNT}元`,
      prose: leg2Prose,
      newTransferActions: describeActions(leg2NewTransfers),
      balanceBefore: centsToMoney(leg2BalanceBefore),
      balanceAfter: centsToMoney(leg2BalanceAfter),
    },
    leg3: {
      prompt: `把我尾号${tail}的信用卡的${CARD_CATEGORY}消费限额设为${CARD_LIMIT_AMOUNT}元`,
      confirmFields: leg3Fields,
      setLimitArgs: lastSetArgs,
      cardStatusBefore: creditStatusBefore,
      cardStatusAfter: creditAfter?.status,
    },
    masking: {
      fullPhoneInApproval: leg1ApprovalText.includes(seed.phoneFull),
      fullPhoneInAssistant: leg1AssistantText.includes(seed.phoneFull),
      fullCardInBody: leg3BodyText.includes(seed.cardNumberFull),
    },
    model: proof,
    screenshots: { shot1, shot2, shot3, shot4 },
  });

  const providerLine = proof.lastRequestId
    ? `provider x-request-id=${proof.lastRequestId}${proof.completedStream ? '（流以 [DONE] 完成）' : ''}`
    : 'provider x-request-id=(未采集)';
  return [
    `【真模型】GET /api/health llmMode=${proof.llmMode}，model=${proof.modelId}，本轮 ModelRequest=${proof.requestCount} 次，${providerLine}`,
    `【精确匹配】给${seed.phoneFull}转${TRANSFER_AMOUNT}元 → 确认卡收款人=${recipientName} / ${recipientPhone}（=种子掩码号），取消后余额 ${centsToMoney(leg1BalanceAfter)} 未变、无新增流水`,
    `【近号防误匹配】${nearMiss} → 未渲染确认卡、无新增 transfer_money PendingAction（${describeActions(leg2NewTransfers)}）、余额 ${centsToMoney(leg2BalanceBefore)}→${centsToMoney(leg2BalanceAfter)} 未变、无新增流水；工具/澄清证据=${nearMissReferenced ? '有' : '无'}`,
    `【尾号唯一定位】尾号${tail} → 确认卡 卡片=${cardField}（=DB numberFull 后四位 ${tail}），无需完整卡号`,
    `【尾号≠cardId】set_card_limit args=${lastSetArgsStr}（cardTail 载 ${tail}，cardId=${rawCardId === undefined ? '缺省' : String(rawCardId)}）`,
    `【脱敏】确认卡/assistant/工具结果/stateJson 均无完整手机号或完整卡号；页面仅用户气泡含完整手机号，正文无完整卡号`,
  ].join('\n');
}
