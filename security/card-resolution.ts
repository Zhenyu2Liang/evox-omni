/**
 * Card-target resolution — SERVER-SIDE, performed at PARK time.
 *
 * Every card mutation (`set_card_limit` / `freeze_card` / `unfreeze_card` / `consume_virtual_card` /
 * `report_lost_card` / `replace_card`) used to accept ONLY a raw `cardId`, so the model had to guess an
 * id and users who said「我的借记卡」or「尾号6688」could not be served. This module is the server-side
 * "user words → card" layer: the model supplies SELECTOR fields, code resolves them against the
 * caller's OWN cards, and the parked + executed args are CANONICALIZED to the resolved `cardId`
 * (`canonicalizeCardArgs`), so the confirmation card names the SAME card the Banking SDK will operate on
 * at execution.
 *
 * Selectors are all optional and may be COMBINED (every supplied selector must match the SAME card):
 *   - `cardId`     exact id of one of the caller's cards (never interpreted as anything else);
 *   - `cardType`   `DEBIT` | `CREDIT` | `VIRTUAL` or a Chinese synonym (`借记卡`/`储蓄卡`/`信用卡`/`虚拟卡`);
 *   - `cardTail`   four trailing digits, accepted as `6688` / `尾号6688` / `****6688` / `...6688`;
 *   - `cardNumber` the COMPLETE fictional number, matched only by exact equality with the server-only
 *                  `numberFull` column (a card without `numberFull` can never match exactly).
 * The candidate set is:
 *   - EXACTLY ONE distinct card  → `resolved`;
 *   - ZERO                        → `not_found`;
 *   - MORE THAN ONE distinct card → `ambiguous` (two credit cards, a shared tail, …).
 *
 * A `cardId` that is not one of the caller's ids is NEVER retried as a tail or a card number: when it
 * merely LOOKS like a tail or a complete number the outcome is an explicit `invalid` refusal, so a
 * guessed/misplaced tail can never happen to hit some other card.
 *
 * It is a pure function of the validated args and the caller's OWN cards (owner isolation: only the
 * caller's cards are ever considered, so a foreign/unknown id can never resolve or leak). It NEVER
 * throws — every outcome is reported so the caller can ask the user to clarify, and every message uses
 * the MASKED number (`numberMasked`) only: a complete card number is never emitted.
 */
import type { Card } from '@/lib/db/prisma';
import type { CardType } from '@/banking-sdk';
import { listCards } from '../lib/db/repositories/card';
import { maskCardNumber } from '../lib/mask';

/** The card selector slots a card call may carry. */
type SelectorKind = 'cardId' | 'cardType' | 'cardTail' | 'cardNumber';

/** Selector order used for stable `kind`/`supplied` reporting (the FIRST supplied selector wins). */
const SELECTOR_KINDS: readonly SelectorKind[] = ['cardId', 'cardType', 'cardTail', 'cardNumber'];

/** The card types the SDK understands. */
const CARD_TYPES: readonly CardType[] = ['DEBIT', 'CREDIT', 'VIRTUAL'];

/** Chinese labels for a card type (shared by the confirmation summary and the clarify messages). */
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  DEBIT: '借记卡',
  CREDIT: '信用卡',
  VIRTUAL: '虚拟卡',
};

/** Chinese synonyms the user actually says, mapped onto the wire values. */
const CARD_TYPE_SYNONYMS: Record<string, CardType> = {
  借记卡: 'DEBIT',
  储蓄卡: 'DEBIT',
  信用卡: 'CREDIT',
  虚拟卡: 'VIRTUAL',
};

/** A resolvable card, projected with MASKED numbers only. */
export interface CardCandidate {
  id: string;
  type: string;
  numberMasked: string;
}

/**
 * Result of a SERVER-SIDE card-target resolution performed at park time. `resolved` names the exact card
 * the SDK will operate on; every other status is a clarification request (nothing is parked).
 * `kind`/`supplied` describe the FIRST supplied selector so the clarify messages stay stable.
 */
export type CardResolution =
  | { status: 'resolved'; card: CardCandidate }
  | { status: 'not_found'; kind: SelectorKind; supplied: string }
  | {
      status: 'ambiguous';
      kind: SelectorKind;
      supplied: string;
      candidates: CardCandidate[];
    }
  | { status: 'invalid'; detail: string };

/** The refusal text for a tail/complete number placed in the `cardId` slot. */
const CARD_ID_SHAPE_REFUSAL =
  '请提供卡片 id 或卡片类型/尾号选择器，不能把尾号或卡号当作卡片 id。';

/** A non-empty string counts as a supplied selector. */
function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Human label for a stored card type (falls back to the raw value for unknown data). */
export function cardTypeLabel(type: string): string {
  return CARD_TYPE_LABELS[type as CardType] ?? type;
}

/** Normalize a card-type selector: wire values (case-insensitive) or a Chinese synonym. */
function toCardType(value: string): CardType | undefined {
  const text = value.trim();
  const synonym = CARD_TYPE_SYNONYMS[text];
  if (synonym) return synonym;
  const upper = text.toUpperCase();
  return (CARD_TYPES as readonly string[]).includes(upper) ? (upper as CardType) : undefined;
}

/** Normalize a tail selector to EXACTLY four digits (`6688` / `尾号6688` / `****6688` / `...6688`). */
function toCardTail(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  return digits.length === 4 ? digits : undefined;
}

/** Normalize a complete card number: 12–19 digits separated only by spaces or dashes. */
function toCardNumber(value: string): string | undefined {
  const digits = value.replace(/[\s-]/g, '');
  return /^\d{12,19}$/.test(digits) ? digits : undefined;
}

/**
 * Does this string merely LOOK like a card tail (four digits) or a complete card number? Only shapes made
 * exclusively of digits / mask characters qualify, so a genuine id such as `card_credit` never does.
 */
function looksLikeCardReference(value: string): boolean {
  const text = value.trim();
  if (!/^(?:尾号)?[\d*\s.·-]+$/.test(text)) return false;
  const digits = text.replace(/\D/g, '');
  return /^\d{4}$/.test(digits) || /^\d{12,19}$/.test(digits);
}

/** A selector is matched only against its declared identity field. */
function cardMatchesSelector(card: Card, kind: SelectorKind, value: string): boolean {
  if (kind === 'cardId') return card.id === value;
  if (kind === 'cardType') return card.type === toCardType(value);
  if (kind === 'cardTail') {
    const tail = toCardTail(value);
    if (tail === undefined) return false;
    if (card.numberMasked.slice(-4) === tail) return true;
    return typeof card.numberFull === 'string' && card.numberFull.slice(-4) === tail;
  }
  const number = toCardNumber(value);
  return number !== undefined && card.numberFull === number;
}

/** Project a card for a clarification list — `id` above all, so the next turn can just send it. */
function toCandidate(card: Card): CardCandidate {
  return { id: card.id, type: card.type, numberMasked: card.numberMasked };
}

/**
 * Resolve the card target SERVER-SIDE at park time. Accepts ONE OR MORE of
 * `cardId` | `cardType` | `cardTail` | `cardNumber` (a completely absent selector is `invalid`). Every
 * supplied selector must match its own facet on the SAME owned card. Never throws.
 */
export async function resolveCardTarget(
  userId: string,
  args: Record<string, unknown>,
): Promise<CardResolution> {
  const keys = SELECTOR_KINDS.filter(key => isPresent(args[key]));
  if (keys.length === 0) {
    return {
      status: 'invalid',
      detail: 'at least one of cardId|cardType|cardTail|cardNumber must be supplied (received: 0)',
    };
  }
  const kind = keys[0];
  const supplied = (args[kind] as string).trim();

  // Reject an unusable selector BEFORE any lookup: a bad type/tail/number can never pick a card.
  if (keys.includes('cardType') && toCardType((args.cardType as string).trim()) === undefined) {
    return { status: 'invalid', detail: `无法识别的卡片类型「${String(args.cardType)}」，请使用 借记卡/信用卡/虚拟卡。` };
  }
  if (keys.includes('cardTail') && toCardTail((args.cardTail as string).trim()) === undefined) {
    return { status: 'invalid', detail: `无法识别的卡片尾号「${String(args.cardTail)}」，请提供 4 位尾号。` };
  }
  if (keys.includes('cardNumber') && toCardNumber((args.cardNumber as string).trim()) === undefined) {
    return { status: 'invalid', detail: '提供完整卡号时必须是不含空格的 12-19 位数字。' };
  }

  // Owner isolation for free: only the caller's OWN cards are ever considered.
  const cards = await listCards(userId);

  // `cardId` means EXACTLY an owned id. A tail/complete number in this slot is an explicit refusal — it
  // must never be re-interpreted as a selector (that is how "尾号6688" would hit an arbitrary card).
  if (kind === 'cardId' && !cards.some(card => card.id === supplied)) {
    return looksLikeCardReference(supplied)
      ? { status: 'invalid', detail: CARD_ID_SHAPE_REFUSAL }
      : { status: 'not_found', kind, supplied };
  }

  const candidates = cards.filter(card => keys.every(key => cardMatchesSelector(card, key, (args[key] as string).trim())));
  if (candidates.length === 0) return { status: 'not_found', kind, supplied };
  if (candidates.length > 1) {
    return { status: 'ambiguous', kind, supplied, candidates: candidates.map(toCandidate) };
  }
  return { status: 'resolved', card: toCandidate(candidates[0]) };
}

/**
 * Express a card call ONLY via the resolved `cardId`, DELETING `cardType` / `cardTail` / `cardNumber`:
 * the persisted + executed args then name one card unambiguously, so the confirmation card and the SDK
 * cannot disagree. Every other argument (amount, category, merchant, reason, …) is preserved EXACTLY.
 */
export function canonicalizeCardArgs(
  args: Record<string, unknown>,
  cardId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args, cardId };
  delete next.cardType;
  delete next.cardTail;
  delete next.cardNumber;
  return next;
}

/** Replace any complete card number echoed in user/model text with its masked form. */
function maskCardReferences(text: string): string {
  return text.replace(/\d{12,19}/g, digits => maskCardNumber(digits));
}

/**
 * Model-readable Chinese clarification for an unresolvable/ambiguous card target. Code-free and
 * number-masked (a complete card number is never emitted). The gateway returns this verbatim so the
 * model asks the user to clarify instead of parking an operation.
 */
export function buildCardClarifyMessage(
  res: Exclude<CardResolution, { status: 'resolved' }>,
): string {
  if (res.status === 'invalid') return maskCardReferences(res.detail);
  if (res.status === 'not_found') {
    return maskCardReferences(
      `未能找到与「${res.supplied}」匹配的卡片，请向用户确认卡片类型或尾号后再试。`,
    );
  }
  const candidates = res.candidates.map(c => `${cardTypeLabel(c.type)} ${c.numberMasked}`).join('、');
  return maskCardReferences(
    `「${res.supplied}」匹配到多张卡片（${candidates}），请向用户确认具体卡片（提供卡片 id 或唯一尾号）。`,
  );
}
