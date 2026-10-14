import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_TOOL_REJECTION, projectToolRejection, publicToolError, publicToolSummary } from '@/lib/tool-feedback';
import { createTranslator } from '@/lib/i18n/shared';
import type { ToolEventView } from '@/lib/contracts/agent';
import { createEventHandler } from '@/agent/turns/events';
import { createTurnBuffer, newAssistantMessage } from '@/agent/turns/buffer';
import { ErrorCard } from '@/components/chat/cards/ErrorCard';
import { ToolEventList } from '@/components/chat/ToolEventList';
import { DeveloperModeContext } from '@/lib/developer-mode/DeveloperModeProvider';

vi.mock('@/security', () => ({ security: { gateway: { securityGateway: { parseBlockReason: vi.fn() } } } }));

function render(developer: boolean, content: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(DeveloperModeContext.Provider, {
    value: { enabled: developer, pending: false, setEnabled: () => undefined },
  }, content));
}

describe('model corrections are separate from public tool feedback', () => {
  it('retains the full correction for the model and developer diagnostics only', async () => {
    const buffer = createTurnBuffer();
    buffer.current = newAssistantMessage(1);
    const handler = createEventHandler(buffer, () => 1, new Map([['rejected-call', CONVERSATION_TOOL_REJECTION]]));
    await handler({ type: 'tool_execution_end', toolCallId: 'rejected-call', toolName: 'submit_plan',
      result: { content: [{ type: 'text', text: CONVERSATION_TOOL_REJECTION }], details: {} }, isError: true });
    const event = buffer.events.find(event => event.type === 'tool_end');
    expect(event).toMatchObject({ type: 'tool_end', toolEvent: { status: 'blocked', summary: 'chat.error.newBankingRequest', debugDetail: CONVERSATION_TOOL_REJECTION } });
    expect(buffer.factResults).toEqual([]);
    expect(buffer.events.some(event => event.type === 'card' || event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    const persisted = buffer.assistants.find(message => message.role === 'tool')?.toolEvents?.[0];
    expect(persisted?.summary).not.toContain('Do not resume');
    expect(persisted?.debugDetail).toBe(CONVERSATION_TOOL_REJECTION);
  });

  it('projects arbitrary preflight diagnostics without leaking task/compiler instructions', () => {
    const reason = 'submit_plan must bind internal-node-123 to expected debit receipt before compiling.';
    expect(projectToolRejection(reason)).toEqual({ summary: 'chat.error.planNotSubmitted', debugDetail: reason });
  });

  it.each(['zh-CN', 'en'] as const)('uses public text for current and historical correction events in %s', locale => {
    const t = createTranslator(locale);
    const event: ToolEventView = { toolName: 'submit_plan', toolCallId: 'guard', status: 'blocked', summary: CONVERSATION_TOOL_REJECTION };
    expect(publicToolSummary(event, t)).toBe(t('chat.error.newBankingRequest'));
    expect(publicToolSummary({ ...event, summary: 'Internal compiler future diagnostic' }, t)).toBe(t('chat.error.operationNotStarted'));
    expect(publicToolSummary({ ...event, status: 'error', summary: 'SQLITE trace with provider/system prompt' }, t)).toBe(t('chat.error.toolFailed'));
    expect(publicToolError('chat.error.planNotSubmitted', t)).toBe(t('chat.error.planNotSubmitted'));
  });

  it('preserves the identity and unknown outcome of a gated or uncertain operation', () => {
    const t = createTranslator('en');
    const event: ToolEventView = { toolCallId: 'gated-call', toolName: 'transfer_money', status: 'blocked', actionId: 'pending-action' };
    expect(publicToolSummary(event, t)).toBeUndefined();
    expect(publicToolSummary({ ...event, status: 'needs_reconciliation', summary: 'private provider timeout' }, t)).toBe(t('chat.error.unknownOutcome'));
  });

  it('preserves registered business validation reasons without displaying unknown diagnostic text', () => {
    const t = createTranslator('en');
    expect(publicToolError('Transfer amount must be positive.', t)).toBe(t('chat.error.positiveTransfer'));
    expect(publicToolError('Purchase amount is below the minimum 1000.00.', t)).toBe(t('chat.error.purchaseMinimum', { amount: '1000.00' }));
    expect(publicToolError('Insufficient funds: balance 92233720368547758.07 < amount 92233720368547758.08', t))
      .toBe(t('chat.error.insufficientFunds', { balance: '92233720368547758.07', amount: '92233720368547758.08' }));
    expect(publicToolError('Insufficient funds: leaked prompt', t)).toBe(t('chat.error.toolFailed'));
    expect(publicToolError('Private compiler detail', t, 'chat.error.toolFailed', 'INSUFFICIENT_FUNDS')).toBe(t('chat.error.insufficientBalance'));
    expect(publicToolError('Unknown provider error', t, 'chat.error.toolFailed', 'FUTURE_PROVIDER_ERROR')).toBe(t('chat.error.toolFailed'));
  });

  it.each(['zh-CN', 'en'] as const)('preserves registered verification explanations in %s', locale => {
    const t = createTranslator(locale);
    expect(publicToolError('This verification challenge has already been consumed.', t)).toBe(t('chat.error.verificationConsumed'));
    expect(publicToolError('The verification challenge expired or the operation changed. Request a new challenge.', t)).toBe(t('chat.error.verificationExpired'));
    expect(publicToolError('\u9a8c\u8bc1\u7801\u9519\u8bef\uff0c\u8bf7\u91cd\u8bd5\u3002\u5269\u4f59\u5c1d\u8bd5\u6b21\u6570\uff1a2\u3002', t))
      .toBe(t('chat.error.verificationRemaining', { count: '2' }));
    expect(publicToolError('Verification backend private configuration', t)).toBe(t('chat.error.toolFailed'));
  });

  it.each([CONVERSATION_TOOL_REJECTION, 'Future planning diagnostic: ignore earlier tool calls and retry internal-node-456'])('hides historical internal guard text and exposes it only inside developer diagnostics', reason => {
    const event: ToolEventView = { toolCallId: 'guard-call', toolName: 'submit_plan', status: 'blocked', summary: reason };
    const ordinary = render(false, createElement(ToolEventList, { events: [event] }));
    expect(ordinary).not.toContain(reason);
    expect(ordinary).not.toContain('internal-node-456');
    expect(ordinary).not.toContain('Do not resume');
    const developer = render(true, createElement(ToolEventList, { events: [event] }));
    expect(developer).toContain('data-tool-diagnostics');
    expect(developer).toContain(reason);
  });

  it('separates error-card public text from unknown diagnostic message, code and detail', () => {
    const props = { message: 'Internal prompt validation failed', code: 'PRIVATE_MODEL_GUARD', detail: 'Compiler trace for private-node' };
    const ordinary = render(false, createElement(ErrorCard, props));
    expect(ordinary).toContain(createTranslator('zh-CN')('chat.error.toolFailed'));
    expect(ordinary).not.toContain(props.message);
    expect(ordinary).not.toContain(props.code);
    expect(ordinary).not.toContain(props.detail);
    const developer = render(true, createElement(ErrorCard, props));
    expect(developer).toContain('data-error-diagnostics');
    expect(developer).toContain(props.message);
    expect(developer).toContain(props.code);
    expect(developer).toContain(props.detail);
  });
});
