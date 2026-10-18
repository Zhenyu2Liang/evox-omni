/**
 * Text markers for the card-lifecycle capability guidance contract.
 *
 * Pure string classification — nothing here re-implements product logic. Two artifacts are
 * policed with the same vocabulary:
 *
 *   - the server-rendered guidance catalogs under `agent/messages/*.json`
 *     (`agent/guidance-messages.ts#renderConversationGuidance` renders them verbatim), and
 *   - the model-facing `agent/system-prompt.ts` paragraph.
 *
 * The contract: advice about cards must never deny a capability the agent really has
 * (`apply_virtual_card`, `replace_card` of an already-lost card), and the manual-only rule must
 * stay scoped to brand-new physical card records (`manual_add_card`) and card deletion
 * (`manual_delete_card`) — see `lib/contracts/card-management.ts` and `lib/contracts/tool-catalog.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Chinese "card" term: sentences outside the card domain are never policed. */
export const CARD_TERM = /卡/;
/** Negation / unavailability markers used by the guidance catalogs. */
export const DENIAL_MARKER = /不能|无法|不支持|不可|禁止|不会/;
/** A sentence that points the user at the Cards page, manual handling or a counter. */
export const MANUAL_PAGE_MARKER = /页面|人工|柜台/;
/** A sentence that states something is required / limited to a channel. */
export const MANUAL_ONLY_MARKER = /需在|必须|仅|只/;
/** Brand-new / added / deleted PHYSICAL card markers. `新卡` covers `新建新卡`-style wording. */
export const PHYSICAL_NEW_CARD_MARKER = /实体卡|新卡|新增|添加|新建|办理新卡/;
export const VIRTUAL_CARD_MARKER = /虚拟/;
/** Acquisition verbs for a card (issue / apply / create). */
export const CARD_ACQUISITION_MARKER = /申请|创建|新建|开卡/;
/** 补办 / replacement of an already-lost card. `挂失` alone is excluded on purpose: reporting a
 * card lost IS irreversible, so "挂失不可撤销" is a true statement, not a capability denial. */
export const CARD_REPLACEMENT_MARKER = /补办|换卡|替换|补发|replace/i;
/** Reporting a card lost — used for the positive-presence assertion. */
export const LOST_CARD_MARKER = /挂失/;

/** Manual-only markers used by the English model-facing system prompt. */
export const PROMPT_MANUAL_ONLY_MARKER = /manual-only|manual only|must be handled manually|cannot be included in an Agent workflow/i;
/** Markers that scope the manual-only rule to BRAND-NEW physical card records. */
export const PROMPT_NEW_CARD_SCOPE_MARKER = /brand-new|brand new|new physical|issuing a new|opening a new|creating a new|adding|additional|new debit|new credit|新建实体卡|新增实体卡|办理新卡|添加实体卡/i;
/** Replacement vocabulary as it appears in the English prompt. */
export const PROMPT_REPLACEMENT_MARKER = /replace|补办|replacement/i;

/**
 * Clause boundary for negation scope. `、` is deliberately NOT a boundary: in
 * "不能创建、申请或删除卡片" the single negation governs the whole enumeration, so the clause
 * after `不能` must stay "创建、申请或删除卡片".
 */
const CLAUSE_DELIMITER = /[，,。；;：:！!？?（）()\n]/;

/**
 * Splits text into sentence-level statements. Chinese/ASCII terminators, newlines and an English
 * full stop followed by whitespace all end a statement; the exact wording of a fix is therefore
 * free, only per-sentence claims are constrained.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；;！？!?])|(?<=\.)\s+|\n+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

/** Every clause a negation marker governs inside one sentence (forward-scoped, up to punctuation). */
export function negationClauses(sentence: string): string[] {
  const clauses: string[] = [];
  const matcher = new RegExp(DENIAL_MARKER.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(sentence)) !== null) {
    const rest = sentence.slice(match.index + match[0].length);
    const end = rest.search(CLAUSE_DELIMITER);
    clauses.push((end === -1 ? rest : rest.slice(0, end)).trim());
  }
  return clauses;
}

export interface CardDenialClause {
  /** The full sentence the denial lives in (used for scoping decisions and failure messages). */
  sentence: string;
  /** The clause the denial marker governs. */
  clause: string;
}

/** Card-domain sentences that deny something, paired with the denied clause. */
export function cardDenialClauses(text: string): CardDenialClause[] {
  return splitSentences(text)
    .filter(sentence => CARD_TERM.test(sentence) && DENIAL_MARKER.test(sentence))
    .flatMap(sentence => negationClauses(sentence).map(clause => ({ sentence, clause })));
}

export interface LocaleCatalog {
  /** File name inside `agent/messages`, e.g. `conversation.zh-CN.json`. */
  file: string;
  /** Nested catalog values as written on disk. */
  raw: Record<string, unknown>;
  /** Flattened `dotted.path` → template text (nested objects are traversed). */
  entries: Record<string, string>;
}

function flattenEntries(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') entries[name] = entry;
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      Object.assign(entries, flattenEntries(entry as Record<string, unknown>, name));
    }
  }
  return entries;
}

/** Discovers every locale catalog on disk, so a new `agent/messages/*.json` enters the scan. */
export function loadLocaleCatalogs(directory = path.join(process.cwd(), 'agent/messages')): LocaleCatalog[] {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const raw = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Record<string, unknown>;
      return { file, raw, entries: flattenEntries(raw) };
    });
}

/**
 * Catalog entries that carry a card-management guidance statement: the rendered
 * `card_management_required` template plus any sibling `*card*` template that itself states a
 * manual handling rule. Entries such as `card_operation_ambiguous` (a genuine capability limit
 * question) are not card-management guidance and stay out of the manual-only assertions.
 */
export function cardManagementEntries(entries: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, text] of Object.entries(entries)) {
    const isRenderedCardGuidance = key === 'card_management_required';
    const isSiblingCardRule = /card/i.test(key) && CARD_TERM.test(text) && MANUAL_ONLY_MARKER.test(text);
    if (isRenderedCardGuidance || isSiblingCardRule) selected[key] = text;
  }
  return selected;
}
