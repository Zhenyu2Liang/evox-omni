/**
 * STAGING COPY — belongs in tests/unit/agent/providers/provider-mock.test.ts; root must relocate it
 * (tests/ is outside ./agent/providers write scope).
 *
 * How to run BEFORE relocation (the repo vitest config only globs `tests/**`, so it will NOT pick
 * up a spec staged under `agent/`):
 *   1. Create a TEMPORARY runner config (e.g. agent/providers/vitest.mock.config.ts) whose
 *      `resolve.alias['@']` = repository root and whose `test.include` is exactly this file.
 *   2. Run it from the REPOSITORY ROOT (not from a worker worktree whose only `node_modules` is a
 *      junction — a junction makes Vitest load a DUPLICATE instance and fail with
 *      "No test suite found in file"):
 *        npx vitest run --config agent/providers/vitest.mock.config.ts
 *   3. Delete the temp config — this spec is the only committed artifact.
 *
 * provider-mock's `mock-responder` — deterministic, DB-free unit spec for the pure "brain" of the
 * offline mock model. `respond(context)` is a PURE state machine over the conversation; these tests
 * pin the exact behaviours the offline pipeline (LLM_MODE=mock) relies on:
 *   - fuzzy Chinese intent → the correct tool call + args,
 *   - transfer recipient resolution across TWO model calls (search_contact → transfer_money),
 *   - multi-turn recipient reuse ("还是刚才那个人，再转100"),
 *   - clarifying questions (missing recipient / missing amount),
 *   - ambiguous-name clarification (no transfer_money emitted),
 *   - honest failure narration (never claims success),
 *   - blocked gated calls → "awaiting confirmation" (YELLOW) / "awaiting MFA" (RED), not executed.
 *
 * Self-contained: imports only `@/agent/providers/mock-responder` + `@earendil-works/pi-ai` faux
 * helpers. Contact ids mirror `tests/helpers/fixtures.ts`
 * (contact_zhangwei 张伟, contact_wangfang 王芳, the duplicate 王芳 = contact_wangfang_2).
 */
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';

import { respond } from '@/agent/providers/mock-responder';
import type { MockContext } from '@/agent/providers/mock-responder';

/* ------------------------------------------------------------------------------- fixtures */

/** The security gateway's opaque block marker (see security/security-gateway.ts:`BLOCK_REASON_PREFIX`). */
const BLOCK_PREFIX = '__SECURITY_BLOCK__';

/** Recipient ids — mirror `tests/helpers/fixtures.ts`. */
const ZHANGWEI = { id: 'contact_zhangwei', name: '张伟' };
const WANGFANG = { id: 'contact_wangfang', name: '王芳' };
const WANGFANG_DUPLICATE = { id: 'contact_wangfang_2', name: '王芳' };

/* ------------------------------------------------------------------------------- builders */

/** A minimal `UserMessage` — `respond` only reads `role` + `content`. */
function userMessage(content: string): UserMessage {
  return { role: 'user', content, timestamp: 0 } as UserMessage;
}

/**
 * A minimal `ToolResultMessage` — `respond` only reads `role`, `toolCallId`, `toolName`,
 * `content` (text), `details` and `isError`. Cast because the SDK type carries extra fields
 * (usage/anthropic-style metadata) that are irrelevant to the pure responder.
 */
function toolResultMessage(partial: {
  toolCallId: string;
  toolName: string;
  text: string;
  details?: unknown;
  isError?: boolean;
}): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: partial.toolCallId,
    toolName: partial.toolName,
    content: [fauxText(partial.text)],
    details: partial.details,
    isError: partial.isError ?? false,
    timestamp: 0,
  } as unknown as ToolResultMessage;
}

/** Wrap a message list into the responder's structural context. */
function ctx(messages: Message[]): MockContext {
  return { messages };
}

/** Every `toolCall` block in an assistant message (id / name / args), in order. */
function toolCallsOf(msg: AssistantMessage): Array<{ id: string; name: string; args: Record<string, any> }> {
  const out: Array<{ id: string; name: string; args: Record<string, any> }> = [];
  for (const block of msg.content) {
    if (block.type === 'toolCall') out.push({ id: block.id, name: block.name, args: block.arguments });
  }
  return out;
}

/** The first `toolCall` block (or `undefined` when the reply is plain text). */
function firstToolCall(
  msg: AssistantMessage,
): { id: string; name: string; args: Record<string, any> } | undefined {
  return toolCallsOf(msg)[0];
}

/** Concatenated text of an assistant message's `text` blocks. */
function textOf(msg: AssistantMessage): string {
  let out = '';
  for (const block of msg.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/* ============================================================ 1. fuzzy intent → tool call */

describe('respond — fuzzy intent classification', () => {
  const cases: ReadonlyArray<[string, string, Record<string, unknown>]> = [
    ['我还有多少钱？', 'get_balance', {}],
    ['帮我看下这个月花了多少', 'analyze_spending', {}],
    ['有没有异常的消费', 'detect_anomaly', {}],
    ['我的卡片', 'get_cards', {}],
    ['查一下订阅', 'list_subscriptions', {}],
    ['理财有哪些', 'list_investments', {}],
    ['这个月流水', 'get_transactions', {}],
  ];

  it.each(cases)('%s ⇒ %s %j', (text, toolName, args) => {
    const msg = respond(ctx([userMessage(text)]));
    const call = firstToolCall(msg);
    expect(call).toBeDefined();
    expect(call!.name).toBe(toolName);
    expect(call!.args).toEqual(args);
    expect(msg.stopReason).toBe('toolUse');
  });
});

/* ============================================================ 2. transfer over two model calls */

describe('respond — transfer resolution across two model calls', () => {
  it('first resolves the recipient via search_contact', () => {
    const msg = respond(ctx([userMessage('给张伟转200元，备注AA')]));
    const call = firstToolCall(msg);
    expect(call).toBeDefined();
    expect(call!.name).toBe('search_contact');
    expect(call!.args).toEqual({ query: '张伟' });
  });

  it('then emits transfer_money once the contact resolves to a single match', () => {
    const request = userMessage('给张伟转200元，备注AA');
    const first = respond(ctx([request]));
    const searchCall = firstToolCall(first)!;
    expect(searchCall.name).toBe('search_contact');

    const resolved = toolResultMessage({
      toolCallId: searchCall.id,
      toolName: 'search_contact',
      text: '找到 1 位联系人：张伟',
      details: [ZHANGWEI],
    });

    const second = respond(ctx([request, first, resolved]));
    const call = firstToolCall(second);
    expect(call).toBeDefined();
    expect(call!.name).toBe('transfer_money');
    expect(call!.args).toEqual({ contactId: 'contact_zhangwei', amount: 200, remark: 'AA' });
  });
});

/* ============================================================ 3. multi-turn recipient reuse */

describe('respond — multi-turn context reuse', () => {
  it('reuses the previous recipient and swaps only the amount', () => {
    const priorTransfer = fauxAssistantMessage(
      [
        fauxText('好的，我来为你处理这笔转账。'),
        fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: 200 }, {
          id: 'call_transfer_money',
        }),
      ],
      { stopReason: 'toolUse' },
    );
    const priorResult = toolResultMessage({
      toolCallId: 'call_transfer_money',
      toolName: 'transfer_money',
      text: '已成功向张伟转账 ¥200.00。',
    });

    const msg = respond(
      ctx([
        userMessage('给张伟转200元'),
        priorTransfer,
        priorResult,
        userMessage('还是刚才那个人，再转100'),
      ]),
    );

    const call = firstToolCall(msg);
    expect(call).toBeDefined();
    expect(call!.name).toBe('transfer_money');
    expect(call!.args).toMatchObject({ contactId: 'contact_zhangwei', amount: 100 });
    // No second recipient lookup — the recipient is reused from history.
    expect(call!.name).not.toBe('search_contact');
  });
});

/* ============================================================ 4. insufficient-info clarification */

describe('respond — insufficient-information clarification', () => {
  it('asks WHO when the recipient is missing (plain text, no tool call)', () => {
    const msg = respond(ctx([userMessage('转账200元')]));
    expect(toolCallsOf(msg)).toHaveLength(0);
    const text = textOf(msg);
    expect(text).toMatch(/转给谁|收款人/);
  });

  it('asks the AMOUNT when the recipient is known but no amount is given', () => {
    const msg = respond(ctx([userMessage('给张伟转账')]));
    expect(toolCallsOf(msg)).toHaveLength(0);
    const text = textOf(msg);
    expect(text).toContain('多少钱');
    expect(text).toContain('张伟');
  });
});

/* ============================================================ 5. ambiguous-name clarification */

describe('respond — ambiguous-name clarification', () => {
  it('lists the matches and does NOT emit transfer_money', () => {
    const request = userMessage('给王芳转100元');
    const first = respond(ctx([request]));
    const searchCall = firstToolCall(first)!;
    expect(searchCall.name).toBe('search_contact');
    expect(searchCall.args).toEqual({ query: '王芳' });

    const resolved = toolResultMessage({
      toolCallId: searchCall.id,
      toolName: 'search_contact',
      text: '找到 2 位联系人：王芳、王芳',
      details: [WANGFANG, WANGFANG_DUPLICATE],
    });

    const second = respond(ctx([request, first, resolved]));
    // Ambiguous ⇒ plain clarifying text, NO money-moving call.
    expect(toolCallsOf(second)).toHaveLength(0);
    const text = textOf(second);
    expect(text).toContain('2 位');
    expect(text).toContain('王芳');
    expect(text).toMatch(/请确认|哪一位|哪一位？/);
  });
});

/* ============================================================ 6. failure narration */

describe('respond — honest failure narration', () => {
  it('reports the failure and never claims success', () => {
    const request = userMessage('帮我查一下余额');
    const call = fauxAssistantMessage(
      [fauxText('好的，我来查一下你的账户余额。'), fauxToolCall('get_balance', {}, { id: 'call_get_balance' })],
      { stopReason: 'toolUse' },
    );
    const failed = toolResultMessage({
      toolCallId: 'call_get_balance',
      toolName: 'get_balance',
      text: '账户查询失败：数据库暂时不可用',
      isError: true,
    });

    const msg = respond(ctx([request, call, failed]));
    const text = textOf(msg);
    expect(text).toContain('未能成功完成');
    // The failure detail is relayed verbatim; success language is never produced.
    expect(text).toContain('数据库暂时不可用');
    expect(text).not.toMatch(/已完成|已成功|余额为|你的账户情况如下/);
    expect(toolCallsOf(msg)).toHaveLength(0);
  });
});

/* ============================================================ 7. blocked gated call */

describe('respond — blocked gated call (awaiting human decision)', () => {
  function blockedTransferResult(blockText: string): ToolResultMessage {
    return toolResultMessage({
      toolCallId: 'call_transfer_money',
      toolName: 'transfer_money',
      text: blockText,
      isError: true,
    });
  }

  const transferCall = fauxAssistantMessage(
    [
      fauxText('好的，我来为你处理这笔转账。'),
      fauxToolCall(
        'transfer_money',
        { contactId: 'contact_zhangwei', amount: 200 },
        { id: 'call_transfer_money' },
      ),
    ],
    { stopReason: 'toolUse' },
  );

  it('YELLOW: reports it awaits the user confirmation and is NOT yet executed', () => {
    const blockedText = `${BLOCK_PREFIX}${JSON.stringify({
      actionId: 'pa_yellow',
      decisionKind: 'confirm_with_user',
    })} 等待确认`;
    const msg = respond(
      ctx([userMessage('给张伟转200元'), transferCall, blockedTransferResult(blockedText)]),
    );
    const text = textOf(msg);
    expect(text).toMatch(/等待确认|需要你确认/);
    expect(text).toContain('尚未执行');
    // Never claims the money moved.
    expect(text).not.toMatch(/已成功|已完成|已执行|转账成功/);
    expect(toolCallsOf(msg)).toHaveLength(0);
  });

  it('RED: reports it requires MFA verification and is NOT yet executed', () => {
    const blockedText = `${BLOCK_PREFIX}${JSON.stringify({
      actionId: 'pa_red',
      decisionKind: 'require_mfa',
    })} 等待验证：请输入 6 位短信验证码`;
    const msg = respond(
      ctx([userMessage('给张伟转5000元'), transferCall, blockedTransferResult(blockedText)]),
    );
    const text = textOf(msg);
    expect(text).toContain('验证码');
    expect(text).toMatch(/等待验证|安全验证/);
    expect(text).toContain('尚未执行');
    // Never claims the money moved.
    expect(text).not.toMatch(/已成功|已完成|已执行|转账成功/);
    expect(toolCallsOf(msg)).toHaveLength(0);
  });
});
