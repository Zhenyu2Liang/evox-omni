/**
 * Unit: security/security-gateway — PendingAction audit trail (userRequest + derived intent).
 *
 * Targets `@/security/security-gateway`: the `TOOL_INTENT` map + `deriveIntent`, and the two
 * persistence touch-points that must carry the audit trail:
 *   - `createPendingAction` / `handleToolCall` persist the ORIGINAL `GatewayContext.userRequest`
 *     together with a CODE-DERIVED `intent` label, and
 *   - `toContractPendingAction` surfaces both on the returned contract `PendingAction`.
 *
 * The intent label is a PURE function of the tool name (LLM-immutable, exactly like the tier): the
 * model can never influence it (it never even sees `GatewayContext`). These specs persist rows, so
 * they need the test SQLite: `useFreshDatabase()`.
 */
import { describe, expect, it } from 'vitest';
import type { ToolName } from '@/lib/contracts/tools';
import { TOOL_POLICY } from '@/security/permission-engine';
import {
  BLOCK_REASON_PREFIX,
  TOOL_INTENT,
  deriveIntent,
  securityGateway,
  type GatewayContext,
} from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { newSessionId } from '../../helpers/scenario';

useFreshDatabase();

/** Proposed tool call carrying the ORIGINAL user request (the audit input). */
function ctxFor(
  toolName: ToolName,
  args: Record<string, unknown>,
  userRequest: string,
  sessionId: string = newSessionId(),
): GatewayContext {
  return { sessionId, userId: DEMO_USER_ID, toolName, args, userRequest };
}

/* ------------------------------------------------------------------- pure: intent */

describe('security-gateway · deriveIntent (pure, code-driven)', () => {
  it('every policy tool has a non-empty intent label (TOOL_INTENT covers the whole ToolName space)', () => {
    const toolNames = Object.keys(TOOL_POLICY) as ToolName[];
    expect(toolNames.length).toBeGreaterThan(0);

    for (const toolName of toolNames) {
      const label = TOOL_INTENT[toolName];
      expect(typeof label, `${toolName} has no TOOL_INTENT label`).toBe('string');
      expect(label.trim(), `${toolName} has an empty TOOL_INTENT label`).not.toBe('');
    }
  });

  it('derives the fixed Chinese label for a representative tool of each tier', () => {
    expect(deriveIntent('transfer_money')).toBe('转账');
    expect(deriveIntent('set_card_limit')).toBe('调整信用卡额度');
    expect(deriveIntent('subscribe_investment')).toBe('理财产品申购');
    expect(deriveIntent('get_balance')).toBe('查询余额');
  });

  it('falls back to the raw tool name for an unknown tool (never empty)', () => {
    expect(deriveIntent('bogus_tool' as ToolName)).toBe('bogus_tool');
  });
});

/* --------------------------------------------------- persisted audit trail (SQLite) */

describe('security-gateway · pending-action audit trail (needs test SQLite)', () => {
  it('persists the ORIGINAL userRequest + a non-empty intent on the row and surfaces both on the contract (YELLOW)', async () => {
    const userRequest = '帮张伟转 200 元';
    const ctx = ctxFor('transfer_money', { amount: 200, contactId: 'contact_zhangwei' }, userRequest);
    const ev = await securityGateway.evaluate(ctx);
    expect(ev.tier).toBe('YELLOW');

    const action = await securityGateway.createPendingAction(ctx, ev);

    // Surfaced on the returned CONTRACT PendingAction.
    expect(action.userRequest).toBe(userRequest);
    expect(action.intent).toBe('转账');
    expect(action.intent).toBe(deriveIntent('transfer_money'));

    // Persisted on the Prisma row — the audit trail's source of truth.
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row).not.toBeNull();
    expect(row!.userRequest).toBe(userRequest);
    expect(row!.intent).toBe('转账');
  });

  it('persists userRequest + intent for a RED action too (status awaiting_mfa)', async () => {
    const userRequest = '帮我认购 5 万元稳健理财';
    const ctx = ctxFor('subscribe_investment', { productId: 'prod_wenjiana', amount: 50000 }, userRequest);
    const ev = await securityGateway.evaluate(ctx);
    expect(ev.tier).toBe('RED');
    expect(ev.requiresMfa).toBe(true);

    const action = await securityGateway.createPendingAction(ctx, ev);

    expect(action.status).toBe('awaiting_mfa');
    expect(action.userRequest).toBe(userRequest);
    expect(action.intent).toBe('理财产品申购');

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row!.userRequest).toBe(userRequest);
    expect(row!.intent).toBe('理财产品申购');
  });

  it('handleToolCall persists userRequest + intent before blocking and returns them on the action', async () => {
    const userRequest = '把信用卡额度调到 5000';
    const ctx = ctxFor('set_card_limit', { cardId: 'card_credit', category: '娱乐', amount: 5000 }, userRequest);

    const auth = await securityGateway.handleToolCall(ctx);

    expect(auth.evaluation.blocked).toBe(true);
    expect(auth.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(true);
    expect(auth.action).toBeDefined();
    expect(auth.action!.userRequest).toBe(userRequest);
    expect(auth.action!.intent).toBe('调整信用卡额度');

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: auth.action!.id } });
    expect(row!.userRequest).toBe(userRequest);
    expect(row!.intent).toBe('调整信用卡额度');
  });

  it('an empty userRequest is preserved verbatim while the intent stays non-empty', async () => {
    const ctx = ctxFor('freeze_card', { cardId: 'card_credit' }, '');
    const ev = await securityGateway.evaluate(ctx);

    const action = await securityGateway.createPendingAction(ctx, ev);

    expect(action.userRequest).toBe('');
    expect(action.intent).toBe('冻结银行卡');
  });
});
