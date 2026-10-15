/**
 * Scenario 15 — Feature 6 credit-limit guard + YELLOW `set_card_limit`.
 *
 * Feature 6 separates a card's per-CATEGORY spend limit (`CardLimit`) from its CREDIT limit
 * (`creditLimitMinor` / `availableLimitMinor`). `set_card_limit` is a YELLOW confirmation-only write
 * that replaces a single `CardLimit` row and MUST NOT touch any credit field.
 *
 * This spec proves that boundary three ways:
 *   1. through the agent (gateway): `set_card_limit` is YELLOW and, after confirmation, changes ONLY
 *      the per-category limit while the credit fields are byte-for-byte unchanged;
 *   2. through the real registry: EVERY agent-reachable card write (`set_card_limit`, `freeze_card`,
 *      `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`) leaves both seeded
 *      cards' credit fields unchanged — and any cards they CREATE carry no credit limit;
 *   3. structurally: no agent-reachable card tool exposes a `creditLimit`/`availableLimit` parameter,
 *      smuggling one is a VALIDATION error, and the only path that sets a credit limit
 *      (`banking.card.addDemoCard`) belongs to the NON-agent manual card-management surface.
 *
 * Fixtures: demo user 李明; `card_credit` (CREDIT, credit/available ¥18,000) and `card_debit` (DEBIT,
 * no credit limit). Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { TOOL_NAMES, isCatalogToolName } from '@/lib/contracts/tool-catalog';
import type { ToolName } from '@/lib/contracts/tools';
import { MFA_CODE } from '@/lib/constants';
import { moneyToCents } from '@/lib/money';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import { confirmAction, newSessionId, runTurn } from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

const CREDIT = 'card_credit';
const DEBIT = 'card_debit';
/** The seeded CREDIT card's credit fields — the values the guard must preserve. */
const SEEDED_CREDIT = { creditLimitMinor: moneyToCents('18000.00'), availableLimitMinor: moneyToCents('18000.00') };
const NO_CREDIT = { creditLimitMinor: null, availableLimitMinor: null };

/** The two credit fields of a card row (`null` when the card holds no credit facility). */
async function creditFields(cardId: string): Promise<{ creditLimitMinor: bigint | null; availableLimitMinor: bigint | null }> {
  const row = await getTestPrisma().card.findUniqueOrThrow({ where: { id: cardId } });
  return { creditLimitMinor: row.creditLimitMinor, availableLimitMinor: row.availableLimitMinor };
}

/** Every agent-reachable card WRITE capability (the read `get_cards` is excluded). */
const CARD_WRITES: readonly ToolName[] = [
  'set_card_limit',
  'freeze_card',
  'unfreeze_card',
  'report_lost_card',
  'replace_card',
  'apply_virtual_card',
];

describe('Scenario 15 — credit-limit guard (Feature 6)', () => {
  it('set_card_limit is YELLOW (confirmation only) and changes ONLY the per-category limit', async () => {
    // Sanity: the seeded CREDIT card really has credit fields, so the guard is meaningful.
    expect(await creditFields(CREDIT)).toEqual(SEEDED_CREDIT);

    const sessionId = newSessionId();
    const agent = buildFauxAgent({
      sessionId,
      script: [
        tool('set_card_limit', { cardId: CREDIT, category: '餐饮', amount: '1200.00' }),
        final('请确认将信用卡餐饮限额调整为 1200 元。'),
      ],
    });
    const res = await runTurn({ sessionId, message: '把信用卡餐饮限额改成1200', agent });

    // YELLOW: a plain confirmation, never MFA.
    expect(res.confirmation).toBeDefined();
    expect(res.mfa).toBeUndefined();
    expect(res.confirmation!.action.tier).toBe('YELLOW');
    expect(res.confirmation!.action.requiresMfa).toBe(false);
    // Nothing was written while the action awaited confirmation.
    expect(await getTestPrisma().cardLimit.count({ where: { cardId: CREDIT, category: '餐饮' } })).toBe(0);

    await confirmAction(agent, res.confirmation!.actionId);

    // Exactly ONE 餐饮 limit row now exists with the new amount.
    const rows = await getTestPrisma().cardLimit.findMany({ where: { cardId: CREDIT, category: '餐饮' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amountMinor).toBe(moneyToCents('1200.00'));

    // The category-limit change never touched the credit limit.
    expect(await creditFields(CREDIT)).toEqual(SEEDED_CREDIT);
    expect(await creditFields(DEBIT)).toEqual(NO_CREDIT);
  });

  it('NO agent-reachable card write mutates creditLimitMinor / availableLimitMinor', async () => {
    expect(await creditFields(CREDIT)).toEqual(SEEDED_CREDIT);
    const registry = createToolRegistry(DEMO_USER_ID);

    // Per-category limit (only the CardLimit row changes)…
    expect((await registry.executeDirect('set_card_limit', { cardId: CREDIT, category: '出行', amount: '300.00' })).ok).toBe(true);
    // …reversible status changes…
    expect((await registry.executeDirect('freeze_card', { cardId: CREDIT })).ok).toBe(true);
    expect((await registry.executeDirect('unfreeze_card', { cardId: CREDIT })).ok).toBe(true);
    // …terminal loss + replacement (which mints a NEW card)…
    expect((await registry.executeDirect('report_lost_card', { cardId: DEBIT })).ok).toBe(true);
    const replaced = await registry.executeDirect('replace_card', { cardId: DEBIT });
    expect(replaced.ok).toBe(true);
    // …and virtual card issuance.
    const virtual = await registry.executeDirect('apply_virtual_card', { monthlyLimit: '2000.00' });
    expect(virtual.ok).toBe(true);

    // Both seeded cards keep their credit fields unchanged.
    expect(await creditFields(CREDIT)).toEqual(SEEDED_CREDIT);
    expect(await creditFields(DEBIT)).toEqual(NO_CREDIT);

    // Cards CREATED by these writes carry no credit limit at all.
    expect(await creditFields((replaced.data as { id: string }).id)).toEqual(NO_CREDIT);
    expect(await creditFields((virtual.data as { id: string }).id)).toEqual(NO_CREDIT);
  });

  it('exposes no agent-reachable parameter that could set a credit limit', async () => {
    const registry = createToolRegistry(DEMO_USER_ID);

    for (const name of CARD_WRITES) {
      const schema = registry.get(name).parameters as { properties?: Record<string, unknown> };
      const keys = Object.keys(schema.properties ?? {});
      expect(keys).not.toContain('creditLimit');
      expect(keys).not.toContain('availableLimit');
      expect(keys).not.toContain('creditLimitMinor');
      expect(keys).not.toContain('availableLimitMinor');
    }

    // Smuggling a credit limit through the model args is rejected before any write.
    const attempts: Array<[ToolName, Record<string, unknown>]> = [
      ['set_card_limit', { cardId: CREDIT, category: '餐饮', amount: '100.00', creditLimit: '99999.00' }],
      ['freeze_card', { cardId: CREDIT, creditLimit: '99999.00' }],
      ['unfreeze_card', { cardId: CREDIT, availableLimit: '99999.00' }],
      ['report_lost_card', { cardId: CREDIT, creditLimit: '99999.00' }],
      ['replace_card', { cardId: CREDIT, creditLimit: '99999.00' }],
      ['apply_virtual_card', { monthlyLimit: '100.00', creditLimit: '99999.00' }],
    ];
    for (const [name, args] of attempts) {
      const result = await registry.executeDirect(name, args);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('VALIDATION');
    }

    // No rejected call wrote anything.
    expect(await creditFields(CREDIT)).toEqual(SEEDED_CREDIT);
  });

  it('only the non-agent manual card creation path can set a credit limit', async () => {
    // `manual_add_card` is a card-management-page command, NOT a catalog/agent capability.
    expect(isCatalogToolName('manual_add_card')).toBe(false);
    expect(TOOL_NAMES).not.toContain('manual_add_card');
    expect(createToolRegistry(DEMO_USER_ID).list().map((entry) => entry.name)).not.toContain('manual_add_card');

    // The direct SDK path the page uses DOES set the credit fields.
    const created = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'CREDIT', creditLimit: '5000.00' });
    expect(created.creditLimit).toBe('5000.00');
    expect(created.availableLimit).toBe('5000.00');
    expect(await creditFields(created.id)).toEqual({
      creditLimitMinor: moneyToCents('5000.00'),
      availableLimitMinor: moneyToCents('5000.00'),
    });
  });
});
