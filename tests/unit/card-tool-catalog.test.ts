/**
 * Card capability catalog + policy — Feature 3/4/6 declarations.
 *
 * Complements `tests/unit/tool-catalog.test.ts` (which owns the global catalog invariants) with the
 * FROZEN facts of the three card features:
 *   - `replace_card` is a static RED write whose replay is receipt-backed + idempotent;
 *   - `apply_virtual_card` is agent-enabled (no longer hidden behind the card-management page) and
 *     likewise a static RED write;
 *   - `set_card_limit` stays a YELLOW confirmation-only write.
 *
 * It also freezes the card LIFECYCLE truth: `replace_card` is card-type NEUTRAL (one tool serves
 * DEBIT, CREDIT and VIRTUAL cards — there are no per-type variants), the model gets no
 * add/open/create/delete PHYSICAL-card tool, and the manual-only operations (`manual_add_card` /
 * `manual_delete_card` in `lib/contracts/card-management.ts`) stay outside the catalog. There is no
 * agent tool, page action or API action for 补办 (replacement).
 *
 * The permission engine derives its table from this catalog, so we ALSO assert the derived policy
 * (tier/`static`/`write`) and the evaluated flags (confirmation + MFA) — the model can never move them.
 */
import { describe, expect, it } from 'vitest';

import { MANUAL_CARD_COMMAND_NAMES, isManualCardCommand } from '@/lib/contracts/card-management';
import {
  AGENT_TOOL_NAMES,
  TOOL_CATALOG,
  TOOL_NAMES,
  catalogEntry,
} from '@/lib/contracts/tool-catalog';
import { evaluateTool, getToolPolicy } from '@/security/permission-engine';
import type { ToolName } from '@/lib/contracts/tools';

/** A static-policy evaluation context (the tier for a static tool never reads these). */
const CTX = { userId: 'user_liming', sessionId: 'sess_catalog_unit', dailyTransferTotal: '0' } as const;

describe('card capability catalog — replace_card / apply_virtual_card / set_card_limit', () => {
  it('replace_card is a static RED write with receipt-backed idempotent replay', () => {
    expect(TOOL_CATALOG.replace_card).toMatchObject({
      category: 'card',
      effect: 'write',
      defaultTier: 'RED',
      authorization: 'static',
      replay: { safety: 'idempotent', maxAttempts: 3, requiresReceipt: true },
    });
    // Agent-reachable: no `agentEnabled: false` opt-out.
    expect(catalogEntry('replace_card')?.agentEnabled).not.toBe(false);
    expect(AGENT_TOOL_NAMES).toContain('replace_card');
  });

  it('apply_virtual_card is an agent-enabled static RED write', () => {
    expect(TOOL_CATALOG.apply_virtual_card).toMatchObject({
      category: 'card',
      effect: 'write',
      defaultTier: 'RED',
      authorization: 'static',
      replay: { safety: 'idempotent', maxAttempts: 3, requiresReceipt: true },
    });
    // Feature 4: the tool is now offered to the model (no longer agent-disabled).
    expect(catalogEntry('apply_virtual_card')?.agentEnabled).not.toBe(false);
    expect(AGENT_TOOL_NAMES).toContain('apply_virtual_card');
  });

  it('derives a RED confirm+MFA write policy for both card-issuance tools', () => {
    for (const name of ['replace_card', 'apply_virtual_card'] as const) {
      expect(getToolPolicy(name)).toMatchObject({ tier: 'RED', static: true, write: true });
      expect(evaluateTool(name, {}, CTX)).toMatchObject({
        tier: 'RED',
        requiresConfirmation: true,
        requiresMfa: true,
      });
    }
  });

  it('keeps set_card_limit a YELLOW confirmation-only write', () => {
    expect(TOOL_CATALOG.set_card_limit).toMatchObject({
      category: 'card',
      effect: 'write',
      defaultTier: 'YELLOW',
      authorization: 'static',
    });
    expect(getToolPolicy('set_card_limit')).toMatchObject({ tier: 'YELLOW', static: true, write: true });
    expect(evaluateTool('set_card_limit', {}, CTX)).toMatchObject({
      tier: 'YELLOW',
      requiresConfirmation: true,
      requiresMfa: false,
    });
  });

  it('catalogs exactly the seven card writes plus the get_cards read', () => {
    const cardTools = TOOL_NAMES.filter((name: ToolName) => TOOL_CATALOG[name].category === 'card').sort();
    expect([...cardTools]).toEqual([
      'apply_virtual_card',
      'consume_virtual_card',
      'freeze_card',
      'get_cards',
      'replace_card',
      'report_lost_card',
      'set_card_limit',
      'unfreeze_card',
    ].sort());
  });
});

describe('card lifecycle truth — one neutral replacement tool, no physical-card tool for the model', () => {
  it('replaces DEBIT, CREDIT and VIRTUAL cards through the single neutral replace_card tool', () => {
    // A per-type replacement variant would mean the model needs card-type knowledge to pick a tool.
    // It does not: one neutral capability covers every type, so no type-suffixed name may exist.
    const perTypeReplacements = TOOL_NAMES.filter((name) =>
      /replace.*(debit|credit|virtual|借记|信用|虚拟|jieji|xinyong|xuni)/i.test(name),
    );
    expect(perTypeReplacements).toEqual([]);
    // ... and exactly one replacement capability exists, for both the catalog and the model.
    expect(TOOL_NAMES.filter((name) => /^replace/i.test(name))).toEqual(['replace_card']);
    expect(AGENT_TOOL_NAMES.filter((name) => /^replace/i.test(name))).toEqual(['replace_card']);

    const entry = catalogEntry('replace_card');
    expect(entry).toBeDefined();
    expect(entry?.agentEnabled).not.toBe(false);
    expect(entry?.effect).toBe('write');
    expect(entry?.defaultTier).toBe('RED');
    expect(entry?.replay.requiresReceipt).toBe(true);
    expect(entry?.replay.maxAttempts).toBe(3);
  });

  it('offers no add/open/create/delete PHYSICAL-card tool — only the virtual issuance tool', () => {
    // Creating a brand-new physical card record or deleting a card is manual-only:
    // `manual_add_card` / `manual_delete_card` (lib/contracts/card-management.ts). They are NOT
    // agent tools, page actions or API actions, and 补办 (replacement) has no such entry at all.
    const forbidden = [
      /^(add|create|open|issue|new)_?card/i,
      /card_(add|create|open|issue|delete|remove|close)/i,
      /^(delete|remove|close)_?card/i,
      /实体卡/,
    ];
    for (const names of [TOOL_NAMES, AGENT_TOOL_NAMES]) {
      for (const pattern of forbidden) {
        expect(names.filter((name) => pattern.test(name))).toEqual([]);
      }
      // The only issuance-flavoured CARD tool is the virtual one. `create_scheduled_task` shares the
      // `create` prefix but is a task tool; a future physical-card tool would fail this loudly.
      const issuanceLike = names.filter((name) => /^(add|create|open|issue|apply|new)/i.test(name));
      expect(issuanceLike.filter((name) => TOOL_CATALOG[name].category === 'card')).toEqual([
        'apply_virtual_card',
      ]);
      expect(issuanceLike.filter((name) => /card/i.test(name))).toEqual(['apply_virtual_card']);
    }

    const virtualEntry = catalogEntry('apply_virtual_card');
    expect(AGENT_TOOL_NAMES).toContain('apply_virtual_card');
    expect(virtualEntry?.defaultTier).toBe('RED');
    expect(virtualEntry?.replay.requiresReceipt).toBe(true);
  });

  it('keeps the manual-only card commands outside the tool catalog', () => {
    expect(MANUAL_CARD_COMMAND_NAMES).toEqual(['manual_add_card', 'manual_delete_card']);
    for (const name of MANUAL_CARD_COMMAND_NAMES) {
      expect(TOOL_NAMES).not.toContain(name);
      expect(AGENT_TOOL_NAMES).not.toContain(name);
      expect(catalogEntry(name)).toBeUndefined();
      expect(isManualCardCommand(name)).toBe(true);
    }
    // Explicit spot checks the guard above depends on.
    expect(catalogEntry('manual_add_card')).toBeUndefined();
    expect(catalogEntry('manual_delete_card')).toBeUndefined();
    // Real catalog capabilities are never mistaken for manual-only commands.
    expect(isManualCardCommand('replace_card')).toBe(false);
    expect(isManualCardCommand('apply_virtual_card')).toBe(false);
    // Manual-only covers create + delete only; it holds NO replacement/补办/reissue command.
    expect(MANUAL_CARD_COMMAND_NAMES.filter((name) => /replace|补办|reissue/i.test(name))).toEqual([]);
  });
});
