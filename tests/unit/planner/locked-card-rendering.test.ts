import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MfaCard } from '@/components/chat/cards/MfaCard';
import { ApprovalRecord } from '@/components/chat/cards/ApprovalRecord';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { ToolEventList } from '@/components/chat/ToolEventList';
import { initialChatUIState, reduceAgentEvents, settleAction, type ChatUIState } from '@/components/chat/agent-stream-reducer';
import type { AgentStreamEvent, ChatCard, ToolEventView } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { createTranslator } from '@/lib/i18n/shared';
import { publicToolSummary } from '@/lib/tool-feedback';
import chatChinese from '@/lib/i18n/messages/chat.zh-CN.json';
import pagesChinese from '@/lib/i18n/messages/pages.zh-CN.json';

/**
 * WEB/RENDER layer of the terminal MFA lock (`status:'locked'`).
 *
 * The server CASes an exhausted verification to `locked`; every user-facing surface then states the
 * lock through TYPED facts (never through the raw refusal text) and offers no way to type another
 * code. `tests/unit/planner/tool-diagnostics.test.ts` only pins `cards.terminal.locked` plus the
 * absence of `<input`/`<button>`; this spec adds the reason sentence, the `data-*` blocks, the
 * closed code-entry surface, the event-stream reducer and `MessageBubble`.
 */

const t = createTranslator('zh-CN');

/** Hostile internal payloads a gateway/provider refusal can carry into the browser. */
const HOSTILE_BLOCK = '__SECURITY_BLOCK__{"decisionKind":"deny"}';
const HOSTILE_JSON = '{"decisionKind":"deny"}';
const HOSTILE_TRACE = 'Error: boom\n    at x (f:1:1)';
const HOSTILE_MESSAGES = [HOSTILE_BLOCK, HOSTILE_JSON, HOSTILE_TRACE];

/** Substrings no public surface may ever render. */
const INTERNAL_LEAKS = ['__SECURITY_BLOCK__', 'decisionKind', '\n    at ', '{"', 'Error:'];

const ACTION_ID = 'action-locked-1';

const summary: PendingActionSummary = {
  actionId: ACTION_ID, title: '冻结卡片', toolName: 'freeze_card',
  tier: 'RED', requiresMfa: true, fields: [],
};

function expectNoInternalLeak(markup: string) {
  for (const leak of INTERNAL_LEAKS) expect(markup).not.toContain(leak);
}

function renderMfa(props: { status?: string; statusMessage?: string; hint?: string }) {
  return renderToStaticMarkup(createElement(MfaCard, { actionId: ACTION_ID, ...props }));
}

function renderApproval(props: { verification?: boolean; status?: string; message?: string }) {
  return renderToStaticMarkup(createElement(ApprovalRecord, { actionId: ACTION_ID, ...props }));
}

type SecurityEvent = Extract<AgentStreamEvent, { type: 'security_event' }>;

function securityEvent(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
  return { type: 'security_event', kind: 'locked', ...overrides };
}

/** Three blocked rows settled into one lock: explicit `MFA_LOCKED`, absent code, `CIRCUIT_OPEN`. */
function blockedRows(): ToolEventView[] {
  return [
    { toolCallId: 'call-mfa', toolName: 'freeze_card', messageId: 'tool-msg', actionId: ACTION_ID,
      status: 'blocked', tier: 'RED', errorCode: 'MFA_LOCKED', summary: HOSTILE_BLOCK },
    { toolCallId: 'call-uncoded', toolName: 'freeze_card', messageId: 'tool-msg', actionId: ACTION_ID,
      status: 'blocked', tier: 'RED', summary: HOSTILE_JSON },
    { toolCallId: 'call-circuit', toolName: 'freeze_card', messageId: 'tool-msg', actionId: ACTION_ID,
      status: 'blocked', tier: 'RED', errorCode: 'CIRCUIT_OPEN', summary: HOSTILE_TRACE },
  ];
}

/** A web state holding the live MFA decision plus the tool rows that produced it. */
function awaitingMfaState(rows: ToolEventView[]): ChatUIState {
  const card: ChatCard = { type: 'mfa', actionId: ACTION_ID, status: 'awaiting_mfa' };
  return initialChatUIState({
    pendingAction: { kind: 'mfa', summary: { ...summary }, actionId: ACTION_ID, hint: '请输入 6 位演示验证码。' },
    toolEvents: rows,
    messages: [{ id: 'tool-msg', role: 'tool', content: '', timestamp: 0, cards: [card], toolEvents: rows }],
  });
}

describe('terminal MFA lock rendering on the web surfaces', () => {
  it('renders the locked verification card from typed facts and closes the code-entry surface', () => {
    const markup = renderMfa({ status: 'locked' });
    expect(markup).toContain('data-mfa-locked');
    // The reason is the catalog rendering of the lock, not the server's raw statusMessage.
    expect(markup).toContain(chatChinese['chat.error.actionLocked']);
    expect(markup).toContain(chatChinese['cards.terminal.locked']);
    // Recovery is a link to the security center, stated in the same words as the page itself.
    expect(markup).toContain(pagesChinese['pages.security.unlockDescription']);
    expect(markup).toContain('href="/security"');
    expect(markup).toContain(pagesChinese['pages.security.title']);
    // No code entry, no action buttons, no verification hint.
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain(chatChinese['cards.mfa.hint']);
    expect(markup).not.toContain('123456');
    // The continuation prompt form (`继续验证：/验证 <id> …`) must never appear here. The reason
    // sentence itself contains the NEGATED phrase 「无法继续验证或执行」, so the phrase is allowed
    // only inside that very sentence — the rest of the card must not offer any continuation.
    expect(markup).not.toContain('/验证');
    expect(markup).not.toContain('继续验证：');
    expect(markup.split(chatChinese['chat.error.actionLocked']).join('')).not.toContain('继续验证');
    expectNoInternalLeak(markup);
  });

  it('keeps the code-entry surface while the attempt budget is open', () => {
    const open = renderMfa({ status: 'awaiting_mfa' });
    expect(open).toContain('<input');
    expect(open).toContain(chatChinese['cards.mfa.hint']);
    expect(open).toContain(chatChinese['cards.verify']);
    expect(open).not.toContain('data-mfa-locked');
    expect(open).not.toContain(chatChinese['cards.terminal.locked']);
    expect(open).not.toContain(chatChinese['chat.error.actionLocked']);
    expect(open).not.toContain('123456');
  });

  it('records a locked approval history with the same reason and no controls', () => {
    for (const verification of [true, false]) {
      const markup = renderApproval({ verification, status: 'locked' });
      expect(markup).toContain('data-approval-locked');
      expect(markup).toContain('data-status="locked"');
      expect(markup).toContain(chatChinese['chat.approval.status.locked']);
      expect(markup).toContain(chatChinese['chat.error.actionLocked']);
      expect(markup).toContain('href="/security"');
      expect(markup).not.toContain('<input');
      expect(markup).not.toContain('<button');
      expectNoInternalLeak(markup);
    }
  });

  it('folds a hostile security_event into the typed locked notice', () => {
    for (const hostile of HOSTILE_MESSAGES) {
      const state = reduceAgentEvents(initialChatUIState(), [
        securityEvent({ code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', message: hostile }),
      ], t);
      expect(state.messages).toHaveLength(1);
      const notice = state.messages[0];
      expect(notice.role).toBe('system');
      // Derived from `code`/`reason` only — the event's own text is never read.
      expect(notice.content).toBe(chatChinese['chat.error.actionLocked']);
      expectNoInternalLeak(notice.content);
    }
    const typed: Array<[Partial<SecurityEvent>, string]> = [
      [{ kind: 'locked', code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' }, chatChinese['chat.error.actionLocked']],
      [{ kind: 'locked', code: 'CIRCUIT_OPEN', reason: 'circuit_open' }, chatChinese['chat.error.securityLocked']],
      [{ kind: 'denied' }, chatChinese['chat.error.securityDenied']],
    ];
    for (const [overrides, expected] of typed) {
      const state = reduceAgentEvents(initialChatUIState(), [securityEvent({ ...overrides, message: HOSTILE_BLOCK })], t);
      expect(state.messages[0].content).toBe(expected);
    }
  });

  it('settles a locked action into typed tool-row summaries without echoing the refusal text', () => {
    const settled = settleAction(awaitingMfaState(blockedRows()), {
      type: 'action_settled', actionId: ACTION_ID, status: 'locked', message: HOSTILE_BLOCK,
    });
    // The live decision is gone and the outcome is recorded against the action.
    expect(settled.pendingAction).toBeUndefined();
    expect(settled.settledActions?.[ACTION_ID]).toBe('locked');

    const card = settled.messages[0].cards?.[0];
    const mfaCard = card && card.type === 'mfa' ? card : undefined;
    expect(mfaCard?.status).toBe('locked');
    // The raw refusal is retained as developer-only data and never rendered as body copy.
    expect(mfaCard?.message).toBe(HOSTILE_BLOCK);

    const rows = settled.messages[0].toolEvents ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.status)).toEqual(['error', 'error', 'error']);
    // The locked branch defaults an absent code to `MFA_LOCKED`; an existing gateway code wins.
    expect(rows.map(row => row.errorCode)).toEqual(['MFA_LOCKED', 'MFA_LOCKED', 'CIRCUIT_OPEN']);
    const summaries = rows.map(row => publicToolSummary(row, t));
    expect(summaries[0]).toBe(chatChinese['chat.error.actionLocked']);
    expect(summaries[1]).toBe(chatChinese['chat.error.actionLocked']);
    expect(summaries[2]).toBe(chatChinese['chat.error.securityLocked']);
    expect(summaries).not.toContain(chatChinese['chat.error.toolFailed']);
    // The live activity panel carries the same rows.
    expect(settled.toolEvents.map(row => publicToolSummary(row, t))).toEqual(summaries);

    const rowMarkup = renderToStaticMarkup(createElement(ToolEventList, { events: rows }));
    expect(rowMarkup).toContain(chatChinese['chat.error.actionLocked']);
    expect(rowMarkup).toContain(chatChinese['chat.error.securityLocked']);
    expect(rowMarkup).not.toContain(chatChinese['chat.error.toolFailed']);
    expectNoInternalLeak(rowMarkup);

    const cardMarkup = renderMfa({ status: mfaCard?.status, statusMessage: mfaCard?.message });
    expect(cardMarkup).toContain(chatChinese['chat.error.actionLocked']);
    expect(cardMarkup).not.toContain(HOSTILE_BLOCK);
    expectNoInternalLeak(cardMarkup);
  });

  it('replaces a hostile system message with the public fallback and keeps clean notices', () => {
    for (const hostile of HOSTILE_MESSAGES) {
      const markup = renderToStaticMarkup(createElement(MessageBubble, {
        message: { id: 'm1', role: 'system', content: hostile, timestamp: 0 },
      }));
      expect(markup).toContain(chatChinese['chat.error.securityDenied']);
      expectNoInternalLeak(markup);
    }
    const clean = '本月已入账消费 1,234.00 元，共 12 笔。';
    const cleanMarkup = renderToStaticMarkup(createElement(MessageBubble, {
      message: { id: 'm2', role: 'system', content: clean, timestamp: 0 },
    }));
    expect(cleanMarkup).toContain(clean);
    expect(cleanMarkup).not.toContain(chatChinese['chat.error.securityDenied']);
  });
});
