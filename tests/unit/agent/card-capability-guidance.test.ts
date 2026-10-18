import { describe, expect, it } from 'vitest';
import { renderConversationGuidance } from '@/agent/guidance-messages';
import {
  CARD_ACQUISITION_MARKER,
  CARD_REPLACEMENT_MARKER,
  CARD_TERM,
  LOST_CARD_MARKER,
  MANUAL_ONLY_MARKER,
  MANUAL_PAGE_MARKER,
  PHYSICAL_NEW_CARD_MARKER,
  VIRTUAL_CARD_MARKER,
  cardDenialClauses,
  cardManagementEntries,
  loadLocaleCatalogs,
  splitSentences,
  type LocaleCatalog,
} from './capability-guidance-markers';

/**
 * Card-lifecycle capability guidance contract — pure, deterministic text assertions.
 *
 * The server renders `agent/messages/conversation.zh-CN.json#card_management_required` verbatim as
 * final assistant text (`agent/guidance-messages.ts#renderConversationGuidance` →
 * `agent/banking-guidance.ts#renderBankingGuidance`), and `agent/write-continuation.ts` does not
 * spend its bounded continuation on guidance envelopes. A false capability claim in that template
 * therefore reaches the user unchanged.
 *
 * Real, model-callable card capabilities that this contract protects:
 *   - `apply_virtual_card`  (write, RED, static authorization, requiresReceipt)
 *   - `replace_card`        (write, RED, static authorization, requiresReceipt) — 补办 of an
 *     already-lost card, supported for DEBIT/CREDIT/VIRTUAL (`banking-sdk/card.ts#replaceCard`).
 * Manual-only operations are only `manual_add_card` (brand-new physical card record) and
 * `manual_delete_card` (`lib/contracts/card-management.ts#MANUAL_CARD_COMMAND_NAMES`); neither is
 * in the tool catalog.
 */

const CATALOGS = loadLocaleCatalogs();

function catalogCases(): [string, LocaleCatalog][] {
  return CATALOGS.map(catalog => [catalog.file, catalog] as [string, LocaleCatalog]);
}

function entryLabel(file: string, key: string, sentence: string): string {
  return `${file}#${key}: "${sentence}"`;
}

describe('card-lifecycle capability guidance', () => {
  describe('catalog discovery', () => {
    it('discovers every locale catalog file under agent/messages', () => {
      const files = CATALOGS.map(catalog => catalog.file);
      expect(files).toContain('conversation.zh-CN.json');
      expect(files.filter(file => file.endsWith('.json'))).toHaveLength(files.length);
      for (const catalog of CATALOGS) {
        expect(Object.keys(catalog.entries).length, catalog.file).toBeGreaterThan(0);
      }
    });

    it('finds at least one catalog that carries card-management guidance', () => {
      const withCardGuidance = CATALOGS.filter(catalog =>
        Object.keys(cardManagementEntries(catalog.entries)).length > 0);
      expect(withCardGuidance.map(catalog => catalog.file)).toContain('conversation.zh-CN.json');
    });
  });

  describe.each(catalogCases())('%s', (file, catalog) => {
    // (a) No false capability denial.
    it('never denies an agent-available card lifecycle capability', () => {
      const violations: string[] = [];
      for (const [key, text] of Object.entries(catalog.entries)) {
        for (const { sentence, clause } of cardDenialClauses(text)) {
          const manualScoped = MANUAL_PAGE_MARKER.test(sentence);
          // Acquiring a card (虚拟卡申请 included) is agent-callable via apply_virtual_card, so no
          // denial may reach it unless the sentence scopes the rule to the manual Cards page.
          if (!manualScoped && CARD_TERM.test(clause) && CARD_ACQUISITION_MARKER.test(clause)) {
            violations.push(`${entryLabel(file, key, sentence)} denies apply_virtual_card ("${clause}")`);
          }
          // A virtual card itself must not be denied without a manual-page scope.
          if (!manualScoped && VIRTUAL_CARD_MARKER.test(clause)) {
            violations.push(`${entryLabel(file, key, sentence)} denies virtual card capability ("${clause}")`);
          }
          // 补办 of an already-lost card is agent-callable via replace_card.
          if (CARD_TERM.test(clause) && CARD_REPLACEMENT_MARKER.test(clause)) {
            violations.push(`${entryLabel(file, key, sentence)} denies replace_card ("${clause}")`);
          }
        }
      }
      expect(violations, `card capability denial in ${file}`).toEqual([]);
    });

    // (b) The manual-only rule is present and scoped to brand-new/deleted PHYSICAL cards.
    it('keeps the manual-only card rule scoped to brand-new or deleted physical cards', () => {
      const manualEntries = cardManagementEntries(catalog.entries);
      for (const [key, text] of Object.entries(manualEntries)) {
        const scoped = splitSentences(text).filter(sentence =>
          MANUAL_PAGE_MARKER.test(sentence)
          && MANUAL_ONLY_MARKER.test(sentence)
          && PHYSICAL_NEW_CARD_MARKER.test(sentence)
          && !VIRTUAL_CARD_MARKER.test(sentence)
          && !CARD_REPLACEMENT_MARKER.test(sentence));
        expect(
          scoped.length,
          `${file}#${key} must keep one sentence stating that brand-new/deleted physical cards are `
          + `manual-only (Cards page + manual-only marker + 实体卡/新卡/新增/添加/新建, and no 虚拟/补办): "${text}"`,
        ).toBeGreaterThan(0);
      }
    });

    // (b, cont.) No sentence may scope 补办 of an already-lost card to the manual channel.
    it('does not scope replacement of an already-lost card to manual handling', () => {
      const offenders = Object.entries(catalog.entries)
        .flatMap(([key, text]) => splitSentences(text)
          .filter(sentence => MANUAL_PAGE_MARKER.test(sentence)
            && MANUAL_ONLY_MARKER.test(sentence)
            && CARD_REPLACEMENT_MARKER.test(sentence))
          .map(sentence => entryLabel(file, key, sentence)));
      expect(offenders, `${file} scopes replace_card to manual handling`).toEqual([]);
    });

    // (c) Positive presence: guidance is not silent about 补办/挂失 when a capability template exists.
    it('is not silent about replacing or reporting a lost card', () => {
      const capabilities = catalog.entries.capabilities;
      if (capabilities === undefined) return; // no capability template: (a)/(b) only.
      const cardGuidance = [catalog.entries.card_management_required, capabilities]
        .filter((text): text is string => typeof text === 'string')
        .join('\n');
      const mentionsLifecycle = LOST_CARD_MARKER.test(cardGuidance)
        || CARD_REPLACEMENT_MARKER.test(cardGuidance);
      expect(
        mentionsLifecycle,
        `${file} card guidance must mention 补办 or 挂失 so a lost card is not a dead end: "${cardGuidance}"`,
      ).toBe(true);
    });

    // (d) Wiring: the assertions above target exactly the string the server renders.
    it('renders exactly the discovered card_management_required template', () => {
      const template = catalog.entries.card_management_required;
      if (template === undefined) return;
      expect(renderConversationGuidance('card_management_required')).toBe(template);
    });
  });
});
