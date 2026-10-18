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
  deniesPhysicalCardsOnly,
  loadLocaleCatalogs,
  overbroadManualOnlyCardProhibitions,
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
 *
 * The contract polices ABSENCE of the false denials plus PRESENCE of the manual-only rule scoped to
 * brand-new/deleted physical cards. It deliberately does not dictate the fix's full wording, and it
 * does not require the templates to advertise 补办: the guidance vocabulary is closed and the
 * model-facing statement of real capabilities lives in `agent/system-prompt.ts`.
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
          // Denying brand-new PHYSICAL card records is true (manual_add_card is not a tool); a
          // denial that reaches virtual cards or card acquisition in general is not.
          const physicalOnly = deniesPhysicalCardsOnly(clause);
          // Acquiring a card (虚拟卡申请 included) is agent-callable via apply_virtual_card, so no
          // denial may reach it unless the sentence scopes the rule to the manual Cards page.
          if (!manualScoped && !physicalOnly && CARD_TERM.test(clause) && CARD_ACQUISITION_MARKER.test(clause)) {
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

    // (c) Wiring: the assertions above target exactly the string the server renders.
    it('renders exactly the discovered card_management_required template', () => {
      const template = catalog.entries.card_management_required;
      if (template === undefined) return;
      expect(renderConversationGuidance('card_management_required')).toBe(template);
    });
  });

  /**
   * Positive/negative examples for the shared sentence + negation-scope vocabulary, so the marker
   * set is pinned independently of the catalogs: the current false denial must be caught, correct
   * fix wordings must pass, and true statements (report-lost is irreversible; brand-new physical
   * card records are manual) must never be reported as capability denials.
   */
  describe('marker vocabulary', () => {
    function scopedManualSentences(text: string): string[] {
      return splitSentences(text).filter(sentence =>
        MANUAL_PAGE_MARKER.test(sentence)
        && MANUAL_ONLY_MARKER.test(sentence)
        && PHYSICAL_NEW_CARD_MARKER.test(sentence)
        && !VIRTUAL_CARD_MARKER.test(sentence)
        && !CARD_REPLACEMENT_MARKER.test(sentence));
    }

    it('catches the current false denial of card application and creation', () => {
      expect(cardDenialClauses('AI 助手不能创建、申请或删除卡片。')).toEqual([
        { sentence: 'AI 助手不能创建、申请或删除卡片。', clause: '创建、申请或删除卡片' },
      ]);
      expect(cardDenialClauses('AI 助手不能创建、申请或删除卡片。')
        .some(({ clause }) => CARD_ACQUISITION_MARKER.test(clause))).toBe(true);
    });

    it('accepts a fix that scopes manual handling to brand-new physical cards and states the real capabilities', () => {
      const fixed = '添加或删除实体卡需在“卡片”页面操作并完成验证。虚拟卡申请与挂失补办可由助手在确认与验证后办理。';
      expect(cardDenialClauses(fixed)).toEqual([]);
      expect(scopedManualSentences(fixed)).toEqual(['添加或删除实体卡需在“卡片”页面操作并完成验证。']);
      expect(CARD_REPLACEMENT_MARKER.test(fixed) || LOST_CARD_MARKER.test(fixed)).toBe(true);
    });

    it('catches a denial of replacing an already-lost card', () => {
      const clauses = cardDenialClauses('已挂失的实体卡不能补办。').map(({ clause }) => clause);
      expect(clauses).toEqual(['补办']);
      expect(clauses.some(clause => CARD_REPLACEMENT_MARKER.test(clause))).toBe(true);
    });

    it('does not read a true statement about report-lost being irreversible as a replacement denial', () => {
      const clauses = cardDenialClauses('挂失不可撤销，之后可请助手补办新卡。').map(({ clause }) => clause);
      expect(clauses.some(clause => CARD_REPLACEMENT_MARKER.test(clause))).toBe(false);
    });

    it('exempts a denial scoped to brand-new physical cards only', () => {
      const [denial] = cardDenialClauses('AI 助手不能新建实体卡。');
      expect(denial.clause).toBe('新建实体卡');
      expect(CARD_ACQUISITION_MARKER.test(denial.clause)).toBe(true);
      expect(deniesPhysicalCardsOnly(denial.clause)).toBe(true);
      // A denial that also reaches virtual cards is not exempt.
      expect(deniesPhysicalCardsOnly('创建、申请或删除实体卡与虚拟卡')).toBe(false);
    });

    it('keeps the manual-only marker distinct from the plain need marker', () => {
      expect(MANUAL_ONLY_MARKER.test('需要给卡片充值，还是调整消费限额？')).toBe(false);
      expect(MANUAL_ONLY_MARKER.test('添加或删除实体卡需在“卡片”页面操作。')).toBe(true);
    });

    /**
     * The model-facing prompt is policed by sentence, so the vocabulary must catch an overbroad card
     * prohibition and accept a rule that stays inside the real manual-only scope. `OVERBROAD` is the
     * prohibition this contract rejects (card acquisition denied as a category); `SHIPPED_SCOPE` is the
     * acceptable shape (brand-new physical card records + card deletion, closed to everything else).
     */
    describe('overbroad manual-only card prohibitions', () => {
      const OVERBROAD =
        'Issuing or deleting physical debit and credit cards remains manual-only on the Cards page and cannot be included in an Agent workflow.';
      const OFFER_FOLLOW_UP = 'Offer replace_card to issue a new card for it.';
      const SHIPPED_SCOPE =
        'Manual-only, on the Cards page with its own page verification, means exactly two things: creating a brand-new physical debit or credit card, and deleting a card record; no other capability is page-only.';

      it('flags the prohibition that names card issuance as a manual-only category', () => {
        expect(overbroadManualOnlyCardProhibitions(OVERBROAD)).toEqual([OVERBROAD]);
        expect(overbroadManualOnlyCardProhibitions('Issuing physical cards is manual-only on the Cards page and cannot be included in an Agent workflow.'))
          .toEqual(['Issuing physical cards is manual-only on the Cards page and cannot be included in an Agent workflow.']);
      });

      it('does not let a follow-up that offers replace_card rescue the prohibition', () => {
        // The pair is the contradiction itself: the prohibition denies card issuance as a category and the
        // next sentence tells the model to issue one. Scope is judged per sentence, so the follow-up
        // never rescues it.
        expect(overbroadManualOnlyCardProhibitions(`${OVERBROAD} ${OFFER_FOLLOW_UP}`)).toEqual([OVERBROAD]);
        expect(overbroadManualOnlyCardProhibitions(OFFER_FOLLOW_UP)).toEqual([]);
      });

      it('accepts the shipped rule scoped to brand-new physical records with a closed manual-only set', () => {
        expect(overbroadManualOnlyCardProhibitions(SHIPPED_SCOPE)).toEqual([]);
        // Either scoping element is enough on its own: brand-new records ...
        expect(overbroadManualOnlyCardProhibitions(
          'Creating a brand-new physical debit or credit card is manual-only on the Cards page.',
        )).toEqual([]);
        // ... and an explicitly closed manual-only set.
        expect(overbroadManualOnlyCardProhibitions(
          'Issuing a card record and deleting one are manual-only, and no other capability is page-only.',
        )).toEqual([]);
      });

      it('accepts a rule that carves out 补办 of an already-lost card', () => {
        const carveOut = 'Cards-page manual-only work does not create or replace cards: replace_card is an agent capability for a LOST card.';
        expect(overbroadManualOnlyCardProhibitions(carveOut)).toEqual([]);
        // The same sentence shape without the carve-out stays flagged, so the passage above is not a
        // blanket exemption for sentences that merely mention cards.
        expect(overbroadManualOnlyCardProhibitions(
          'Cards-page manual-only work cannot be included in an Agent workflow for card creation.',
        )).toEqual(['Cards-page manual-only work cannot be included in an Agent workflow for card creation.']);
      });

      it('leaves card sentences that state no manual-only rule alone', () => {
        expect(overbroadManualOnlyCardProhibitions('虚拟卡申请需由助手确认并完成验证后办理。')).toEqual([]);
        expect(overbroadManualOnlyCardProhibitions('Offer replace_card whenever the user asks to 补办 a LOST card.'))
          .toEqual([]);
      });
    });
  });
});
