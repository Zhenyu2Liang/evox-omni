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
 * The permission engine derives its table from this catalog, so we ALSO assert the derived policy
 * (tier/`static`/`write`) and the evaluated flags (confirmation + MFA) — the model can never move them.
 */
import { describe, expect, it } from 'vitest';

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
