/**
 * tests/integration/card-manual-only-management.test.ts — SQLITE-BACKED regression for the CARD
 * CREATION / DELETION capability boundary: making a brand-new card record and deleting an existing
 * card are MANUAL-ONLY operations, reachable ONLY from the human card-management page/API.
 *
 * INVARIANT UNDER TEST (root CONTEXT.md; `lib/contracts/card-management.ts`; `security/security-gateway.ts`;
 * `agent/confirmation/gated-execution.ts`): `manual_add_card` and `manual_delete_card` are the two
 * `ManualCardCommandName`s. On the human page (`security/manual-card-management.ts`) each one owns its
 * own proposal, its own MFA challenge, its own strict audit row and its own execution receipt.
 * `manual_add_card` / `manual_delete_card` are NOT agent capabilities: the
 * runtime's tool/command path must REFUSE them, and a refused attempt must leave the database exactly
 * as it was — NO new `Card` row, NO `PendingAction`, NO `MfaChallenge`, NO `CardLimit`, NO
 * `CardConsumption` and NO `ExecutionReceipt`.
 *
 * WHY THIS IS DB-BACKED AND DRIVEN THROUGH THE REAL PATH: "refused" is only meaningful together with
 * "nothing happened". A refusal that still parked a `PendingAction` (or that dropped the card row on
 * the way out) would be indistinguishable from a success at the storage level, and the demo web client
 * renders a confirmation panel for every `PendingAction`. These cases therefore drive the SAME entry
 * points the runtime uses — `createToolRegistry(...).get` / `.executeDirect`,
 * `agent#executeGatedTool` (the gated command path) and the `securityGateway`'s `handleToolCall` /
 * `authorizeAction` / `cancelAction` — and diff the persisted rows around every call.
 *
 * The happy path of these two commands (proposal → wrong code → correct code → card created/deleted,
 * with its audit and receipt) is covered by `tests/app/manual-card-management.test.ts`; this file only
 * covers what the AGENT path may not do.
 *
 * CONTRACT NOTE ON THE TYPED REFUSAL. Every agent-facing refusal below is `SECURITY_DENIED` with one
 * of two messages: `manual_add_card` / `manual_delete_card` are not catalog entries at all, so
 * `registry.get` / `executeDirect` report `This banking capability is unavailable.`, while the gated
 * command path and the decision endpoints report the card-management-page message. The gateway's own
 * pre-flight (`securityGateway#handleToolCall` → `permission-engine#evaluateTool`) refuses the same
 * names one step earlier, as an UNKNOWN capability (`VALIDATION`), because the policy table is keyed by
 * the agent catalog; the assertions below pin whichever code each entry point actually raises, and no
 * case accepts "either code".
 *
 * Fixtures (`tests/helpers/fixtures.ts`): demo user 李明 — CHECKING `acct_checking` ¥23,580.00 (the
 * default settlement account, mask `****8821`), SAVINGS `acct_savings` ¥50,000.00, `card_credit`
 * (CREDIT `****6688`, ¥18,000.00 available, debt-free) and `card_debit` (DEBIT), both `ACTIVE`. No
 * VIRTUAL and no `LOST` card is seeded. Money is asserted as exact CNY minor units / decimal strings.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { executeGatedTool, getDemoSession } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import type { ManualCardCommandName } from '@/lib/contracts/card-management';
import type { ToolName } from '@/lib/contracts/tools';
import { AppError } from '@/lib/errors';
import { securityGateway } from '@/security/security-gateway';
import { proposeCardChange } from '@/security/manual-card-management';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

const db = () => getTestPrisma();

/** The seeded CHECKING account — the only account a VIRTUAL card may settle against. */
const CHECKING = 'acct_checking';
/** The seeded CREDIT card (¥18,000.00 available, no outstanding debt, so it is deletable). */
const CREDIT = 'card_credit';
/** The seeded DEBIT card — a physical record with no limit and no settlement binding. */
const DEBIT = 'card_debit';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** The demo user's server-owned workspace identity (there is no login and no workspace selection). */
async function owner(): Promise<{ userId: string; sessionId: string }> {
  const session = await getDemoSession(DEMO_USER_ID);
  return { userId: session.userId, sessionId: session.sessionId };
}

/** A manual-only command name, viewed as a tool name the runtime could try to invoke. */
function asToolName(name: ManualCardCommandName): ToolName {
  return name as unknown as ToolName;
}

/**
 * Every persisted effect a card-lifecycle write could leave behind, scoped to the DEMO USER and
 * ordered, so a before/after diff proves the absence of a side effect without hardcoding a
 * whole-database card count.
 */
async function sideEffects(): Promise<{
  cards: Array<{ id: string; type: string; status: string }>;
  pendingActions: number;
  mfaChallenges: number;
  cardLimits: number;
  consumptions: number;
  receipts: number;
}> {
  const [cards, pendingActions, mfaChallenges, cardLimits, consumptions, receipts] = await Promise.all([
    db().card.findMany({
      where: { userId: DEMO_USER_ID },
      select: { id: true, type: true, status: true },
      orderBy: { id: 'asc' },
    }),
    db().pendingAction.count({ where: { userId: DEMO_USER_ID } }),
    db().mfaChallenge.count({ where: { action: { userId: DEMO_USER_ID } } }),
    db().cardLimit.count({ where: { card: { userId: DEMO_USER_ID } } }),
    db().cardConsumption.count({ where: { userId: DEMO_USER_ID } }),
    db().executionReceipt.count({ where: { userId: DEMO_USER_ID } }),
  ]);
  return { cards, pendingActions, mfaChallenges, cardLimits, consumptions, receipts };
}

/** The typed refusal produced by a synchronous throw. */
function captureSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('manual card creation is refused on the agent/command path', () => {
  it('refuses manual_add_card for a physical card and creates no card row', async () => {
    const { userId, sessionId } = await owner();
    const registry = createToolRegistry(userId);
    const name = asToolName('manual_add_card');
    const args = { type: 'DEBIT', monthlyLimit: '1000.00' };
    const userRequest = '给我办一张新的实体借记卡';
    const before = await sideEffects();

    // (1) The capability is not offered to the model and cannot be looked up …
    expect(registry.list().map((tool) => tool.name as string)).not.toContain('manual_add_card');
    const lookupError = captureSync(() => registry.get(name));
    expect(lookupError).toBeInstanceOf(AppError);
    expect(lookupError).toMatchObject({
      code: 'SECURITY_DENIED',
      message: 'This banking capability is unavailable.',
    });

    // … nor dispatched directly.
    expect(await registry.executeDirect(name, args)).toEqual({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'This banking capability is unavailable.',
    });

    // (2) The gated command path the runtime actually uses refuses with the card-management message
    // and never parks the call for a human decision.
    const gated = await executeGatedTool({ userId, sessionId, toolName: name, args, userRequest });
    expect(gated).toEqual({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'Card creation and deletion require the card management page.',
    });
    expect(gated.pendingActionId).toBeUndefined();
    expect(gated.requiresConfirmation).toBeUndefined();

    // (3) The gateway's own pre-flight refuses the name as an unknown agent capability, one step
    // BEFORE it could persist anything (the policy table is keyed by the agent catalog).
    await expect(
      securityGateway.handleToolCall({ userId, sessionId, toolName: name, args, userRequest }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'Unknown banking tool: manual_add_card' });

    // NOTHING was created: same owned cards, same statuses, no action, no challenge, no limit, no
    // consumption, no receipt.
    expect(await sideEffects()).toEqual(before);
    expect(before.cards.map((card) => card.id)).toEqual([CREDIT, DEBIT].sort());
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'DEBIT' } })).toBe(1);
  });

  it('refuses manual_add_card for a VIRTUAL card bound to the seeded CHECKING account', async () => {
    const { userId, sessionId } = await owner();
    const registry = createToolRegistry(userId);
    const name = asToolName('manual_add_card');
    const args = { type: 'VIRTUAL', linkedAccountId: CHECKING, monthlyLimit: '2000.00' };
    const userRequest = '给我开一张虚拟卡';
    const before = await sideEffects();
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' } })).toBe(0);

    const lookupError = captureSync(() => registry.get(name));
    expect(lookupError).toMatchObject({ code: 'SECURITY_DENIED' });

    expect(await registry.executeDirect(name, args)).toEqual({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'This banking capability is unavailable.',
    });

    const gated = await executeGatedTool({ userId, sessionId, toolName: name, args, userRequest });
    expect(gated).toMatchObject({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'Card creation and deletion require the card management page.',
    });

    await expect(
      securityGateway.handleToolCall({ userId, sessionId, toolName: name, args, userRequest }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'Unknown banking tool: manual_add_card' });

    // A VIRTUAL record would have added a `Card` row carrying the binding; none exists.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' } })).toBe(0);
    expect(await sideEffects()).toEqual(before);
    // The binding itself is intact and untouched: no settlement-binding change, no cash movement.
    const checking = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });
    expect(checking.balanceMinor).toBe(2358000n);
    expect(checking.number).toBe('****8821');
  });
});

describe('manual card deletion is refused on the agent/command path', () => {
  it.each([
    { cardId: CREDIT, type: 'CREDIT' },
    { cardId: DEBIT, type: 'DEBIT' },
  ])('refuses manual_delete_card for the seeded $type card and keeps it ACTIVE', async ({ cardId }) => {
    const { userId, sessionId } = await owner();
    const registry = createToolRegistry(userId);
    const name = asToolName('manual_delete_card');
    const args = { cardId };
    const userRequest = `把卡 ${cardId} 删掉`;
    const before = await sideEffects();

    const lookupError = captureSync(() => registry.get(name));
    expect(lookupError).toMatchObject({
      code: 'SECURITY_DENIED',
      message: 'This banking capability is unavailable.',
    });

    expect(await registry.executeDirect(name, args)).toEqual({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'This banking capability is unavailable.',
    });

    const gated = await executeGatedTool({ userId, sessionId, toolName: name, args, userRequest });
    expect(gated).toMatchObject({
      ok: false,
      errorCode: 'SECURITY_DENIED',
      error: 'Card creation and deletion require the card management page.',
    });
    expect(gated.pendingActionId).toBeUndefined();

    await expect(
      securityGateway.handleToolCall({ userId, sessionId, toolName: name, args, userRequest }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: 'Unknown banking tool: manual_delete_card' });

    // The card is still there, with its original status and (for CREDIT) its original limit.
    const card = await db().card.findUniqueOrThrow({ where: { id: cardId } });
    expect(card).toMatchObject({ userId: DEMO_USER_ID, status: 'ACTIVE' });
    expect(await sideEffects()).toEqual(before);
  });

  it('cannot settle a genuine manual card change through the gateway decision endpoints', async () => {
    const { userId, sessionId } = await owner();
    // The human page path is the ONE owner of this row: it proposes the change and issues its own
    // challenge, so the row exists exactly as the card-management page leaves it.
    const proposal = await proposeCardChange({ userId, sessionId }, { requestId: randomUUID(), cardId: CREDIT });
    const proposed = await db().pendingAction.findUniqueOrThrow({
      where: { id: proposal.change.id },
      include: { mfa: true },
    });
    expect(proposed).toMatchObject({
      userId: DEMO_USER_ID,
      toolName: 'manual_delete_card',
      riskLevel: 'RED',
      requiresMfa: true,
      status: 'awaiting_mfa',
    });
    expect(proposed.mfa?.status).toBe('pending');
    const before = await sideEffects();

    // The agent decision endpoints refuse the row outright — no code, no ownership path, no execution.
    await expect(securityGateway.authorizeAction(proposed.id, { userId, sessionId })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
      message: 'Use the card management page to confirm this change.',
    });
    await expect(securityGateway.cancelAction(proposed.id, { userId, sessionId })).rejects.toMatchObject({
      code: 'SECURITY_DENIED',
      message: 'Use the card management page to cancel this change.',
    });

    // Neither decision settled the row, consumed the challenge or removed the card.
    expect(await sideEffects()).toEqual(before);
    const settled = await db().pendingAction.findUniqueOrThrow({
      where: { id: proposed.id },
      include: { mfa: true },
    });
    expect(settled.status).toBe('awaiting_mfa');
    expect(settled.mfa?.status).toBe('pending');
    expect(settled.mfa?.consumedAt).toBeNull();
    expect(settled.resultJson).toBeNull();
    const card = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(card.status).toBe('ACTIVE');
    expect(card.availableLimitMinor).toBe(1800000n);
  });
});
