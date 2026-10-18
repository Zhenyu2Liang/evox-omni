/**
 * Scenario 18 — 卡片能力的「咨询 / 歧义 / 指引」契约：不能办事，也不能否认真实能力。
 *
 * Pipeline (PRODUCTION runtime, only the MODEL is scripted — path A):
 *   user message → `@/agent#runTurn` (durable admission + `describe_turn` interpretation +
 *   `groundMessage` presentation) → Pi Agent → banking tools → Security Gateway `beforeToolCall`.
 *   The provider is `tests/helpers/scripted-provider`, which PREPENDS a real `describe_turn` call and
 *   then consumes exactly ONE scripted step per model call. Nothing here goes through the raw Pi
 *   harness (`tests/helpers/scenario.ts`), because only the production entry renders the guidance
 *   envelope (`agent/turns/buffer.ts#groundMessage` → `agent/banking-guidance.ts`) and only the
 *   production entry records a `describe_turn` `toolInvocation` row.
 *
 * What each case proves:
 *  1. A CONSULTATION about card replacement performs no banking work: plain explanatory prose and a
 *     `card_management_required` guidance envelope both end with no gate, no `PendingAction`, no
 *     receipt, no `replace_card`/`apply_virtual_card` invocation, an unchanged card set and an
 *     unchanged checking balance. A capability question is never an instruction to use the capability.
 *  2. An AMBIGUOUS 补办 request (several owned cards, no card named) yields a clarification — either
 *     the structured `missing_details` envelope (rendered by the server, not by the model) or ordinary
 *     prose asking which card — and still performs no work. A clarification is NOT a confirmation/MFA
 *     panel: no `PendingAction` exists, so no panel may be claimed.
 *  3. Capability GUIDANCE must not deny a capability the product really exposes. The rendered guidance
 *     and the runtime system prompt must not tell the model that creating/applying cards is impossible
 *     or that replacing a LOST card is manual-only. This is the EXPECTED PRE-FIX FAILURE in this
 *     worktree: `agent/messages/conversation.zh-CN.json#card_management_required` still says
 *     「AI 助手不能创建、申请或删除卡片」 and `agent/system-prompt.ts:38` still says
 *     「Issuing or deleting physical debit and credit cards remains manual-only on the Cards page and
 *     cannot be included in an Agent workflow.」 immediately before `offer replace_card to issue a new
 *     card for it. Those assertions are intentionally NOT weakened, skipped or softened.
 *
 * Cross-references (not duplicated here):
 *  - `test-13-card-replace.test.ts` — DEBIT replacement through the gateway with the raw Pi harness.
 *  - `test-14-virtual-card.test.ts`  — virtual-card application (`apply_virtual_card`, RED MFA).
 *  - `test-19-card-replace-credit-runtime.test.ts` — CREDIT replacement through the PRODUCTION
 *    runtime: the capability this file's case 3 says guidance must not deny.
 *  - `tests/unit/agent/system-prompt.test.ts` owns the system-prompt SENTENCE itself; this spec only
 *    pins the contract of the prompt the production runtime actually renders.
 *
 * World: the shared seed holds exactly TWO ACTIVE cards for 李明 — `card_credit` (CREDIT, ****6688)
 * and `card_debit` (DEBIT, ****8821) — so every card assertion is a DELTA against a before-snapshot
 * (or an id/type lookup), never a hardcoded whole-DB total. Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';

import { loadSession, runTurn } from '@/agent';
import { buildSystemPrompt } from '@/agent/system-prompt';
import type { ModelRuntime } from '@/agent/providers/types';
import type { AppConfig } from '@/lib/config';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { AGENT_TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { scriptedProvider } from '../helpers/scripted-provider';

useFreshDatabase();

const db = getTestPrisma;

/** `tests/setup.ts` pins LLM_MODE=mock; the write-continuation is gated on `llmMode === 'live'`. */
const config: AppConfig = {
  llmMode: 'mock',
  llmProvider: 'card-capability',
  llmModel: 'card-capability-model',
  demoUserId: DEMO_USER_ID,
};
const liveConfig: AppConfig = { ...config, llmMode: 'live' };

/** A REAL gate is a persisted PendingAction surfaced by the gateway — never model prose. */
function hasGate(turn: Pick<ChatTurnResponse, 'events'>): boolean {
  return turn.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required');
}

/** The final assistant text of the turn (the grounded/rendered one the user sees). */
function finalContent(turn: Pick<ChatTurnResponse, 'events'>): string {
  return turn.events
    .flatMap(event => (event.type === 'message_end' && event.message.role === 'assistant' ? [event.message.content] : []))
    .filter(Boolean)
    .at(-1) ?? '';
}

/** Drive one production turn with a scripted provider (path A). */
function runScripted(
  message: string,
  declaration: Parameters<typeof scriptedProvider>[0],
  steps: readonly FauxResponseStep[],
  runtimeConfig: AppConfig = config,
  sessionId?: string,
): Promise<{ turn: ChatTurnResponse; script: { provider: ModelRuntime; calls(): number } }> {
  const script = scriptedProvider(declaration, steps);
  return runTurn({ message, ...(sessionId === undefined ? {} : { sessionId }) }, {
    config: runtimeConfig,
    provider: script.provider,
  }).then(turn => ({ turn, script }));
}

/** Neither a card write, nor a gate, nor a receipt, nor a moved balance may result. */
async function expectNoCardWork(beforeCards: number, beforeBalanceMinor: bigint): Promise<void> {
  expect(await db().pendingAction.count()).toBe(0);
  expect(await db().executionReceipt.count()).toBe(0);
  expect(await db().toolInvocation.count({ where: { toolName: { in: ['replace_card', 'apply_virtual_card'] } } })).toBe(0);
  expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(beforeCards);
  expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(beforeBalanceMinor);
}

/** Snapshot the card set and the settlement balance so every assertion is a DELTA. */
async function snapshot(): Promise<{ cards: number; balanceMinor: bigint }> {
  return {
    cards: await db().card.count({ where: { userId: DEMO_USER_ID } }),
    balanceMinor: (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor,
  };
}

/**
 * The production runtime persists the model's interpretation as a `describe_turn` invocation even
 * though it never surfaces as a `tool_start`/`tool_end` event. Asserting it proves this spec drove the
 * REAL production entry rather than the raw Pi harness.
 */
async function expectProductionRuntime(): Promise<void> {
  expect(await db().toolInvocation.count({ where: { toolName: 'describe_turn' } })).toBe(1);
}

const CONSULTATION = '补办信用卡怎么办理？需要什么材料？';
const EXPLANATION =
  '补办信用卡可以先在“卡片”页面把丢失的卡片标记为挂失，再提交补办申请；也可以用一句话告诉我卡片丢了，我会发起补办并在验证通过后为你生成一张新卡。补办后原卡保持挂失状态。';

describe('Scenario 18 case 1 — 咨询卡片能力不产生任何操作', () => {
  it('answers an advisory question with prose and performs no card work', async () => {
    const before = await snapshot();

    const { turn, script } = await runScripted(CONSULTATION, { purpose: 'advice', operations: [] }, [
      fauxAssistantMessage(EXPLANATION),
    ]);

    // The declaration plus exactly one answer — no hidden extra model request.
    expect(script.calls()).toBe(2);
    await expectProductionRuntime();

    // Explanatory prose is preserved verbatim by `renderConversationalResponse`.
    const text = finalContent(turn);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toBe(EXPLANATION);

    // A question about a capability is not an instruction to use it.
    expect(hasGate(turn)).toBe(false);
    expect(turn.events.some(event => event.type === 'card')).toBe(false);
    await expectNoCardWork(before.cards, before.balanceMinor);
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
  });

  it('renders the card_management_required guidance envelope server-side and performs no card work', async () => {
    const before = await snapshot();

    const { turn, script } = await runScripted(CONSULTATION, { purpose: 'advice', operations: [] }, [
      fauxAssistantMessage('{"guidance":{"code":"card_management_required"}}'),
    ]);
    expect(script.calls()).toBe(2);
    await expectProductionRuntime();

    // The raw JSON envelope NEVER reaches the user: the closed server template replaced it in place.
    const text = finalContent(turn);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('guidance');
    expect(text).toContain('卡片');

    expect(hasGate(turn)).toBe(false);
    // No controlled tool call at all: guidance is not an effect.
    expect(turn.events.some(event => event.type === 'tool_start' && event.toolEvent.toolName !== 'describe_turn')).toBe(false);
    await expectNoCardWork(before.cards, before.balanceMinor);
    // A valid guidance envelope short-circuits the write-continuation: no budget is spent.
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
  });
});

describe('Scenario 18 case 2 — 卡片歧义只产生澄清，不产生操作', () => {
  it('renders the missing_details clarification for 帮我把卡补办一下 without touching a card', async () => {
    const before = await snapshot();

    const { turn, script } = await runScripted(
      '帮我把卡补办一下',
      // The user really does want a replacement, but did not say WHICH of the owned cards.
      { purpose: 'operation', operations: ['replace_card'] },
      [fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["card"]}}')],
      // `live` proves the declared write does NOT spend the bounded continuation on a clarification.
      liveConfig,
    );
    // declaration + the clarification; the continuation is short-circuited by the guidance envelope.
    expect(script.calls()).toBe(2);
    await expectProductionRuntime();

    // The structured clarification is rendered by the SERVER from its closed field vocabulary.
    expect(finalContent(turn)).toBe('请补充卡片类型或尾号，再继续处理；未创建操作授权。');

    // A clarification is not a gate: no PendingAction, so no confirmation/MFA panel exists.
    expect(hasGate(turn)).toBe(false);
    expect(turn.events.some(event => event.type === 'tool_start' || event.type === 'tool_end')).toBe(false);
    await expectNoCardWork(before.cards, before.balanceMinor);
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).replacedByCardId).toBeNull();
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_debit' } })).replacedByCardId).toBeNull();
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
  });

  it('accepts a plain-text follow-up question as an equivalent clarification with the same no-effect bundle', async () => {
    const before = await snapshot();

    const clarification = '请告诉我你想补办哪一张卡：信用卡 ****6688 还是借记卡 ****8821？';
    const { turn, script } = await runScripted(
      '帮我把卡补办一下',
      { purpose: 'operation', operations: ['replace_card'] },
      [fauxAssistantMessage(clarification)],
    );
    expect(script.calls()).toBe(2);
    await expectProductionRuntime();

    // Ordinary prose asking for the missing detail counts equally: no structured code is required.
    expect(finalContent(turn)).toBe(clarification);
    expect(hasGate(turn)).toBe(false);
    await expectNoCardWork(before.cards, before.balanceMinor);
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
  });
});

/**
 * Case 3 — the capability guidance and the runtime system prompt must not deny real capability.
 *
 * Labelled separately because it is the EXPECTED PRE-FIX FAILURE of this worktree: the assertions are
 * negative only (they never require specific replacement wording), they encode the CONTRACT, and they
 * fail today on the wording that is actually shipped.
 */
describe('Scenario 18 case 3 — 能力指引与系统提示不得否认真实能力 (EXPECTED PRE-FIX FAILURE)', () => {
  /** Negations that would make the agent deny a capability the catalog really registers. */
  const DENIES_CARD_CREATION = /不能[^。]*(创建|申请)[^。]*卡/;
  const DENIES_CARD_REPLACEMENT_AS_MANUAL = /补办[^。]*(只能|需在)[^。]*(手动|卡片页面)/;

  it('card_management_required guidance does not claim the assistant cannot create or apply cards', async () => {
    const before = await snapshot();
    const { turn } = await runScripted(CONSULTATION, { purpose: 'advice', operations: [] }, [
      fauxAssistantMessage('{"guidance":{"code":"card_management_required"}}'),
    ]);

    const text = finalContent(turn);
    expect(text.length).toBeGreaterThan(0);
    // CONTRACT: `replace_card` and `apply_virtual_card` are registered RED agent capabilities, so the
    // guidance may route MANUAL-ONLY work (adding a brand-new card, deleting a card) to the Cards page,
    // but it must never state that the assistant cannot create/apply cards at all.
    expect(text).not.toMatch(DENIES_CARD_CREATION);
    // CONTRACT: replacing a LOST card is agent-reachable, so 补办 must never be described as manual-only
    // or as something that only happens on the Cards page.
    expect(text).not.toMatch(DENIES_CARD_REPLACEMENT_AS_MANUAL);
    // The guidance still performs no work (unchanged by the wording contract above).
    expect(hasGate(turn)).toBe(false);
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(before.cards);
  });

  it('the rendered system prompt does not contradict itself about 补办 of a lost card', () => {
    // Mirror `agent/banking-agent.ts:238` — the production runtime builds the prompt from the registry
    // tool names with the turn-intent tool enabled.
    const prompt = buildSystemPrompt({
      userId: DEMO_USER_ID,
      toolNames: [...AGENT_TOOL_NAMES],
      turnIntentTool: true,
    });

    // Precondition: the capability the guidance must not deny IS offered to the model.
    expect(prompt).toContain('- replace_card: RED');
    expect(prompt).toContain('- apply_virtual_card: RED');

    // CONTRACT: a "manual-only / cannot be included in an Agent workflow" prohibition about physical
    // cards must be SCOPED — it must carve out the agent-reachable lost-card replacement. Today the
    // prohibition covers card issuance as a category and is immediately followed, in the same
    // paragraph, by "offer replace_card to issue a new card for it": the prompt tells the model both
    // that issuing a card is impossible and that it should issue one.
    const sentences = prompt
      .split(/(?<=[.。])\s+|\n+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);
    const prohibition = /manual[- ]only|cannot be included in an Agent workflow/i;
    const cardWord = /card/i;
    const issuanceVerb = /(issu|creat|applic|发放|创建|申请)/i;
    const replacementCarveOut = /replac|补办|换卡/i;
    const overbroad = sentences.filter(sentence =>
      prohibition.test(sentence) && cardWord.test(sentence) && issuanceVerb.test(sentence) &&
      !replacementCarveOut.test(sentence));
    expect(
      overbroad,
      `系统提示把卡片发放整体说成只能人工，却同时要求 offer replace_card：${overbroad.join(' | ')}`,
    ).toEqual([]);

    // CONTRACT: the prompt must not scope 补办 itself to manual work (Chinese wording, if it exists).
    expect(prompt).not.toMatch(/补办[^。]*(只能|仅能|需在)[^。]*(手动|卡片页面)/);
  });
});
