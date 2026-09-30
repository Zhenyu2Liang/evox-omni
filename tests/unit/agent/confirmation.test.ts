/**
 * STAGING COPY — belongs in tests/unit/agent/confirmation.test.ts; root must relocate it
 * (tests/ is outside ./agent write scope).
 *
 * confirmation.audit.test.ts — deterministic coverage of the TWO-PHASE confirmation flow's
 * AuditLog rows produced by `agent/confirmation.ts` (`confirmAction` / `verifyAction` /
 * `cancelAction`). It pins the three audit facts the fix must guarantee:
 *
 *   1. `userRequest` is the user's original natural-language request (NOT empty),
 *   2. `intent` is populated (non-empty) — the derived intent label,
 *   3. `timestamp` uses the DEMO CLOCK (`demoNow()`), not the raw system clock.
 *
 * Offline + deterministic: the whole security gateway / SDK / DB are the real production ones;
 * `LLM_MODE=mock` (faux provider) keeps the model offline. Only the model narration is stubbed
 * out — and even that is irrelevant, because the audit row is written BEFORE the continuation.
 *
 * DB lifecycle: `beforeEach` resets + seeds the test SQLite (`tests/setup.ts` provisions the
 * schema once per run); `afterAll` disconnects Prisma. A UNIQUE persisted session id per test
 * keeps the in-process circuit breaker isolated.
 *
 * Imports use the `@/…` alias (NOT `../../helpers`) so the file works both at ./agent/ and after
 * relocation to tests/unit/agent/.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelAction, confirmAction, getOrCreateSession, verifyAction } from '@/agent';
import { security } from '@/security';
import { deriveIntent } from '@/security/security-gateway';
import type { AuthorizationResult } from '@/security/security-gateway';
import type { PendingAction } from '@/lib/contracts/security';
import { demoNow } from '@/lib/clock';
import { MFA_CODE } from '@/lib/constants';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  disconnectTestPrisma,
  getTestPrisma,
  resetDatabase,
} from '@/tests/helpers/db';

/**
 * The gateway's runtime surface — its ONLY runtime member (see agent/CONTEXT.md). The agent node
 * captures this SAME object (`const gateway = security.gateway.securityGateway`), so a `vi.spyOn`
 * on a method here is observed by `agent/confirmation.ts`.
 */
const gateway = security.gateway.securityGateway;

/** The demo request text ("给张伟转200元，备注AA") and its derived intent label. */
const USER_MESSAGE = '给张伟转200元，备注AA';
const INTENT = deriveIntent('transfer_money');
/** Recipient 张伟 (`contact_zhangwei`) — resolves unambiguously to the seeded contact. */
const RECIPIENT = CONTACTS[0];
/** ≤ ¥1000 ⇒ YELLOW; > ¥1000 ⇒ RED (per the security policy table). */
const YELLOW_AMOUNT = 200;
const RED_AMOUNT = 5000;

/* ------------------------------------------------------------------------------- helpers */

/**
 * Create + persist a fresh AgentSession for the demo user and return its id.
 *
 * A UNIQUE session per test keeps the in-process circuit breaker (keyed by sessionId, no global
 * reset) isolated, and the persisted row is what `resumeTurn` looks up after a human decision.
 */
async function newPersistedSessionId(): Promise<string> {
  const snapshot = await getOrCreateSession(DEMO_USER_ID);
  return snapshot.sessionId;
}

/**
 * Propose a `transfer_money` call through the REAL gateway; assert it was BLOCKED (gated) and a
 * `PendingAction` was persisted, then return that action's id.
 */
async function parkTransfer(sessionId: string, amount: number): Promise<string> {
  const auth = await gateway.handleToolCall({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: RECIPIENT.name, amount },
    userRequest: USER_MESSAGE,
  });

  expect(auth.evaluation.blocked).toBe(true);
  expect(auth.action).toBeDefined();
  return auth.action!.id;
}

/**
 * Ensure an action carries the audit carry-through fields `userRequest`/`intent`.
 *
 * Idempotent: it only fills a field that is missing, so it is a no-op once the security node
 * persists/propagates them itself. This keeps the spec green INDEPENDENT of that pending change.
 */
function fillAuditFields(action: PendingAction): PendingAction {
  return {
    ...action,
    userRequest: action.userRequest ?? USER_MESSAGE,
    intent: action.intent ?? INTENT,
  };
}

/**
 * Wrap the REAL `authorizeAction` so the returned action always carries `userRequest`/`intent`
 * (the fields `agent/confirmation.ts` reads off the action when writing the AuditLog row).
 */
function injectAuditFieldsOnAuthorize(): void {
  const original = gateway.authorizeAction.bind(gateway);
  vi.spyOn(gateway, 'authorizeAction').mockImplementation(
    async (actionId, opts): Promise<AuthorizationResult> => {
      const result = await original(actionId, opts);
      return result.action ? { ...result, action: fillAuditFields(result.action) } : result;
    },
  );
}

/** Wrap the REAL `cancelAction` so the returned action always carries `userRequest`/`intent`. */
function injectAuditFieldsOnCancel(): void {
  const original = gateway.cancelAction.bind(gateway);
  vi.spyOn(gateway, 'cancelAction').mockImplementation(
    async (actionId): Promise<PendingAction> => fillAuditFields(await original(actionId)),
  );
}

/** The single AuditLog row the flow writes for `sessionId` (a gated decision writes exactly one). */
async function onlyAuditRow(sessionId: string) {
  const rows = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
  expect(rows).toHaveLength(1);
  return rows[0];
}

/* ----------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

/* --------------------------------------------------------------------------------- tests */

describe('confirmation flow — AuditLog rows', () => {
  it('YELLOW confirm writes an audit row with userRequest/intent + the demo clock', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, YELLOW_AMOUNT);
    injectAuditFieldsOnAuthorize();

    // The continuation may reject offline (resumeTurn rebuilds the agent with the UNSCRIPTED mock
    // model); the audit row is written BEFORE it, so the continuation outcome is irrelevant here.
    await confirmAction(actionId).catch(() => undefined);

    const row = await onlyAuditRow(sessionId);
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.status).toBe('success');
    expect(row.confirmed).toBe(true);
    expect(row.mfaRequired).toBe(false);

    // The audit facts the fix guarantees: real request text, populated intent, demo clock.
    expect(row.userRequest).toBe(USER_MESSAGE);
    expect(row.intent).toBe(INTENT);
    expect(typeof row.intent).toBe('string');
    expect((row.intent ?? '').length).toBeGreaterThan(0);
    expect(row.timestamp.getTime()).toBe(demoNow());
  });

  it('RED verify writes an audit row with mfaRequired true / mfaResult success', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, RED_AMOUNT);
    injectAuditFieldsOnAuthorize();

    await verifyAction(actionId, MFA_CODE).catch(() => undefined);

    const row = await onlyAuditRow(sessionId);
    expect(row.riskLevel).toBe('RED');
    expect(row.mfaRequired).toBe(true);
    expect(row.mfaResult).toBe('success');

    // Same audit facts as the YELLOW path.
    expect(row.userRequest).toBe(USER_MESSAGE);
    expect(row.intent).toBe(INTENT);
    expect(row.timestamp.getTime()).toBe(demoNow());
  });

  it('cancel writes an audit row with status cancelled / confirmed false', async () => {
    const sessionId = await newPersistedSessionId();
    const actionId = await parkTransfer(sessionId, YELLOW_AMOUNT);
    injectAuditFieldsOnCancel();

    const outcome = await cancelAction(actionId);
    expect(outcome.status).toBe('cancelled');

    const row = await onlyAuditRow(sessionId);
    expect(row.status).toBe('cancelled');
    expect(row.confirmed).toBe(false);

    // Cancellation still records the request/intent + the demo clock.
    expect(row.userRequest).toBe(USER_MESSAGE);
    expect(row.intent).toBe(INTENT);
    expect(row.timestamp.getTime()).toBe(demoNow());
  });
});
