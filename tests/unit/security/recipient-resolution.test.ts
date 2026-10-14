/**
 * Unit: security/security-gateway — SERVER-SIDE transfer-recipient resolution at PARK time.
 *
 * Pins the regression where `gatewayCreatePendingAction` resolves a `transfer_money` recipient
 * SERVER-SIDE (`resolveTransferRecipient`, mirroring `banking-sdk/transfer.ts`) and DRIFTED from the
 * SDK: without it the confirmation card showed a stale/heuristic 收款人 while the SDK executed a
 * DIFFERENT (or ambiguous) contact, or parked an operation for a recipient that can never resolve.
 *
 * Rules under test (exactly ONE of `contactId|phone|name` may be supplied):
 *   - `contactId` → look up + owner-check (`not_found` otherwise);
 *   - `phone` → complete normalized or masked identity (`not_found` when incomplete, `ambiguous` > 1);
 *   - `name` → exact name equality (`not_found` 0, `ambiguous` > 1);
 *   - 0 or > 1 identifiers → `invalid`.
 * On `resolved` the args are CANONICALIZED to `{...args, contactId}` (with `phone`/`name` DELETED) and
 * the summary emits `收款人` (real name) → `收款手机号` (MASKED) → `金额` → `账户` → `风险等级`, so the
 * card names the SAME contact the SDK will resolve at execution.
 * On any non-resolved outcome NOTHING is persisted: `handleToolCall` returns a DENY whose `blockReason`
 * is a PLAIN model-readable clarify message (NOT a `BLOCK_REASON_PREFIX` payload), and the public
 * `securityGateway.createPendingAction` wrapper throws `AppError('VALIDATION')`.
 *
 * DB-backed (reads contacts/accounts) → needs the test SQLite via `../helpers/db`. Unique `sessionId`
 * per test so the in-process circuit-breaker state never leaks.
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';
import type { PendingAction } from '@/lib/contracts/security';
import type { ToolName } from '@/lib/contracts/tools';
import { security } from '@/security';
import {
  BLOCK_REASON_PREFIX,
  maskPhone,
  securityGateway,
  type GatewayContext,
} from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { newSessionId } from '../../helpers/scenario';

// The per-test DB reset + seed (`useFreshDatabase`) is I/O heavy and can exceed the 10 s default
// hook timeout; give it more room (assertions/determinism untouched).
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** The seeded 张伟 contact (`tests/helpers/fixtures.ts` CONTACTS[0]). */
const ZHANGWEI_ID = 'contact_zhangwei';
const ZHANGWEI_NAME = '张伟';
const ZHANGWEI_PHONE = '139****0002';
/** The seeded 活期 checking account (fixtures ACCOUNTS[0]) — the default funding source. */
const CHECKING_ACCOUNT_ID = 'acct_checking';
const CHECKING_ACCOUNT_NAME = '活期账户';

/** EXACT field order the transfer confirmation card MUST emit. */
const RECIPIENT_FIELD_ORDER = ['收款人', '收款手机号', 'Amount', '账户', '风险等级'];

/* ------------------------------------------------------------------ helpers */

/** Proposed tool call context; `sessionId` defaults to a fresh id so breaker state never leaks. */
function ctxFor(
  toolName: ToolName,
  args: Record<string, unknown> = {},
  sessionId: string = newSessionId(),
): GatewayContext {
  return { sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: '演示请求' };
}

/** Label sequence of a summary's fields (proves ordering + presence). */
function fieldLabels(action: PendingAction): string[] {
  return action.summary.fields.map((f) => f.label);
}

/** Value of the summary field with the given label (`undefined` when absent). */
function fieldValue(action: PendingAction, label: string): string | undefined {
  return action.summary.fields.find((f) => f.label === label)?.value;
}

/** Park a `transfer_money` call through the public wrapper (evaluate → createPendingAction). */
async function parkTransfer(
  args: Record<string, unknown>,
  sessionId: string = newSessionId(),
): Promise<PendingAction> {
  const ctx = ctxFor('transfer_money', args, sessionId);
  return securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
}

/* --------------------------------------------------- (a) resolved recipients */

describe('security-gateway · transfer recipient resolution — resolved selectors', () => {
  it('resolves 张伟 by NAME → canonical contactId args + masked summary', async () => {
    const action = await parkTransfer({ amount: '200.00', name: ZHANGWEI_NAME });

    expect(action.status).toBe('pending');
    expect(action.tier).toBe('YELLOW');
    expect(fieldLabels(action)).toEqual(RECIPIENT_FIELD_ORDER);
    expect(fieldValue(action, '收款人')).toBe(ZHANGWEI_NAME);
    expect(fieldValue(action, '收款手机号')).toBe('139****0002');
    expect(fieldValue(action, '收款手机号')).toBe(maskPhone(ZHANGWEI_PHONE));

    // Canonicalized: only the resolved `contactId` survives; the selector keys are DELETED.
    expect(action.args.contactId).toBe(ZHANGWEI_ID);
    expect('name' in action.args).toBe(false);
    expect('phone' in action.args).toBe(false);

    // The PERSISTED row carries the SAME canonical args (what the SDK will execute).
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row).not.toBeNull();
    const persisted = JSON.parse(row?.argsJson ?? '{}') as Record<string, unknown>;
    expect(persisted.contactId).toBe(ZHANGWEI_ID);
    expect('name' in persisted).toBe(false);
    expect('phone' in persisted).toBe(false);
  });

  it('resolves a complete phone → canonical contactId args + masked summary', async () => {
    const action = await parkTransfer({ amount: '200.00', phone: '13900000002' });

    expect(action.status).toBe('pending');
    expect(action.tier).toBe('YELLOW');
    expect(fieldLabels(action)).toEqual(RECIPIENT_FIELD_ORDER);
    expect(fieldValue(action, '收款人')).toBe(ZHANGWEI_NAME);
    expect(fieldValue(action, '收款手机号')).toBe(maskPhone(ZHANGWEI_PHONE));
    expect(action.args.contactId).toBe(ZHANGWEI_ID);
    expect('name' in action.args).toBe(false);
    expect('phone' in action.args).toBe(false);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    const persisted = JSON.parse(row?.argsJson ?? '{}') as Record<string, unknown>;
    expect(persisted.contactId).toBe(ZHANGWEI_ID);
    expect('phone' in persisted).toBe(false);
  });

  it('resolves by contactId through BOTH createPendingAction and handleToolCall (identical result)', async () => {
    const action = await parkTransfer({ amount: '200.00', contactId: ZHANGWEI_ID });

    expect(action.status).toBe('pending');
    expect(action.tier).toBe('YELLOW');
    expect(fieldLabels(action)).toEqual(RECIPIENT_FIELD_ORDER);
    expect(fieldValue(action, '收款人')).toBe(ZHANGWEI_NAME);
    expect(fieldValue(action, '收款手机号')).toBe(maskPhone(ZHANGWEI_PHONE));
    expect(action.args.contactId).toBe(ZHANGWEI_ID);
    expect('name' in action.args).toBe(false);
    expect('phone' in action.args).toBe(false);

    // The REAL `beforeToolCall` entry point (`handleToolCall`) parks the SAME action.
    const res = await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: '200.00', contactId: ZHANGWEI_ID }),
    );
    expect(res.evaluation.blocked).toBe(true);
    expect(res.decision.kind).toBe('require_confirmation');
    expect(res.action?.status).toBe('pending');
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(true);
    expect(res.action && fieldLabels(res.action)).toEqual(RECIPIENT_FIELD_ORDER);
    expect(res.action && fieldValue(res.action, '收款人')).toBe(ZHANGWEI_NAME);
    expect(res.action && fieldValue(res.action, '收款手机号')).toBe(maskPhone(ZHANGWEI_PHONE));
    expect(res.action?.args.contactId).toBe(ZHANGWEI_ID);
    expect(res.action !== undefined && 'name' in res.action.args).toBe(false);
    expect(res.action !== undefined && 'phone' in res.action.args).toBe(false);
  });

  it('labels the funding account from a valid sourceAccountId (活期账户)', async () => {
    const action = await parkTransfer({
      amount: '200.00',
      contactId: ZHANGWEI_ID,
      sourceAccountId: CHECKING_ACCOUNT_ID,
    });

    expect(fieldLabels(action)).toEqual(RECIPIENT_FIELD_ORDER);
    expect(fieldValue(action, '账户')).toBe(CHECKING_ACCOUNT_NAME);
    // The funding selector is preserved EXACTLY (not part of canonicalization).
    expect(action.args.sourceAccountId).toBe(CHECKING_ACCOUNT_ID);
    expect(action.args.contactId).toBe(ZHANGWEI_ID);
  });

  it('is exposed identically through the @/security facade', async () => {
    const ctx = ctxFor('transfer_money', { amount: '200.00', contactId: ZHANGWEI_ID });
    const facadeGateway = security.gateway.securityGateway;
    const action = await facadeGateway.createPendingAction(ctx, await facadeGateway.evaluate(ctx));

    expect(fieldValue(action, '收款人')).toBe(ZHANGWEI_NAME);
    expect(action.args.contactId).toBe(ZHANGWEI_ID);
    expect(action.summary.fields.map((f) => f.label)).toEqual(RECIPIENT_FIELD_ORDER);
  });
});

/* -------------------------------------------- (b) unresolvable → clarify deny */

describe('security-gateway · transfer recipient resolution — unresolvable selectors', () => {
  it('MISSING recipient → plain clarify DENY, nothing persisted, wrapper throws VALIDATION', async () => {
    const before = await getTestPrisma().pendingAction.count();
    const ctx = ctxFor('transfer_money', { amount: '200.00' });

    const res = await securityGateway.handleToolCall(ctx);

    expect(res.decision.kind).toBe('deny');
    expect(res.action).toBeUndefined();
    expect(res.blockReason).toContain('请提供且仅提供一个收款人标识');
    // The clarify message is PLAIN model-readable text — NOT an opaque block-reason payload.
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(false);
    expect(await getTestPrisma().pendingAction.count()).toBe(before);

    // The public wrapper surfaces the same clarification as a typed VALIDATION error.
    const wrapCtx = ctxFor('transfer_money', { amount: '200.00' });
    const err = await securityGateway
      .createPendingAction(wrapCtx, await securityGateway.evaluate(wrapCtx))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION');
    expect(await getTestPrisma().pendingAction.count()).toBe(before);
  });

  it('UNKNOWN name → not_found clarify DENY, nothing persisted', async () => {
    const before = await getTestPrisma().pendingAction.count();

    const res = await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: '200.00', name: '不存在的人' }),
    );

    expect(res.decision.kind).toBe('deny');
    expect(res.action).toBeUndefined();
    expect(res.blockReason).toContain('未能找到');
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(false);
    expect(await getTestPrisma().pendingAction.count()).toBe(before);
  });

  it('AMBIGUOUS name → masked clarify DENY, nothing persisted', async () => {
    // A SECOND contact literally named 张伟 makes the name selector unresolvable by equality.
    await getTestPrisma().contact.create({
      data: {
        id: 'contact_zhangwei_2',
        userId: DEMO_USER_ID,
        name: ZHANGWEI_NAME,
        phone: '131****0009',
        bank: '中国银行',
      },
    });

    const before = await getTestPrisma().pendingAction.count();

    const res = await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: '200.00', name: ZHANGWEI_NAME }),
    );

    expect(res.decision.kind).toBe('deny');
    expect(res.action).toBeUndefined();
    expect(res.blockReason).toContain('匹配到多个联系人');
    // Candidates are phone-MASKED (never a raw number on the clarify message).
    expect(res.blockReason).toContain('****');
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(false);
    expect(await getTestPrisma().pendingAction.count()).toBe(before);
  });
});
