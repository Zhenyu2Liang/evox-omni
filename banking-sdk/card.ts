/**
 * Banking SDK — card reads & mutations.
 * `getCards` is GREEN; the mutations are executed only after the Security Gateway's tier policy
 * (YELLOW/RED) is satisfied — this module performs no permission checks itself.
 *
 * Domain invariants enforced here (never by the model):
 *  - the card must exist → `AppError('NOT_FOUND')`;
 *  - a per-category limit needs a non-empty category and a non-negative amount
 *    → `AppError('VALIDATION')`;
 *  - a `LOST` card can neither be frozen nor unfrozen, and an already-`LOST` card cannot be
 *    reported lost again → `AppError('CONFLICT')`;
 *  - freezing an already-frozen (or unfreezing an already-active) card is idempotent: the current
 *    status is returned without a write.
 *
 * `setCardLimit` replaces a card+category limit as a single all-or-nothing unit
 * (`runInTransaction`): the delete and the create commit together, so the card never ends up with
 * zero or duplicate limit rows for that category.
 */
import type { Card as CardRow, CardLimit as CardLimitRow } from '@prisma/client';
import { cards } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { round2 } from '../lib/money';
import { runInTransaction } from './tx';
import type {
  ApplyVirtualCardInput,
  CardStatus,
  CardType,
  CardView,
  ReportLostCardInput,
  SetCardLimitInput,
} from './types';

/** Network of a newly issued virtual card (demo sandbox). */
const VIRTUAL_CARD_NETWORK = 'UnionPay';

/** Map a Prisma card row + its category limits onto the frozen `CardView` DTO. */
function toCardView(row: CardRow, limits: CardLimitRow[]): CardView {
  return {
    id: row.id,
    type: row.type as CardType,
    network: row.network,
    numberMasked: row.numberMasked,
    status: row.status as CardStatus,
    creditLimit: row.creditLimit ?? undefined,
    availableLimit: row.availableLimit ?? undefined,
    monthlyLimit: row.monthlyLimit ?? undefined,
    limits: limits.map((limit) => ({ category: limit.category, amount: limit.amount })),
  };
}

/** Map a card row onto a `CardView`, loading its per-category limits. */
async function loadCardView(row: CardRow): Promise<CardView> {
  return toCardView(row, await cards.listCardLimits(row.id));
}

/** Resolve a card or throw `AppError('NOT_FOUND')`. */
async function requireCard(cardId: string): Promise<CardRow> {
  const row = typeof cardId === 'string' && cardId.length > 0 ? await cards.getCard(cardId) : null;
  if (!row) throw new AppError('NOT_FOUND', `卡片不存在：${String(cardId)}`, { cardId });
  return row;
}

/**
 * Move a card to `next`, allowing the transition only from `allowedFrom`.
 * A card already in `next` is returned untouched (idempotent, no write); any other status is an
 * illegal transition → `AppError('CONFLICT')`.
 */
async function transitionTo(
  row: CardRow,
  next: CardStatus,
  allowedFrom: readonly CardStatus[],
): Promise<CardRow> {
  const current = row.status as CardStatus;
  if (current === next) return row;
  if (!allowedFrom.includes(current)) {
    throw new AppError('CONFLICT', `卡片当前状态 ${current} 不允许变更为 ${next}`, {
      cardId: row.id,
      from: current,
      to: next,
    });
  }
  return cards.updateCardStatus(row.id, next);
}

/** All cards owned by the user (with per-category limits). */
export async function getCards(userId: string): Promise<CardView[]> {
  const rows = await cards.listCards(userId);
  return Promise.all(rows.map(loadCardView));
}

/** Set/replace the per-category spend limit on a card; returns the updated card. */
export async function setCardLimit(input: SetCardLimitInput): Promise<CardView> {
  const row = await requireCard(input?.cardId);

  const category = typeof input?.category === 'string' ? input.category.trim() : '';
  if (category === '') {
    throw new AppError('VALIDATION', '缺少限额分类', { cardId: row.id, category: input?.category });
  }
  const amount = round2(input?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError('VALIDATION', '限额必须是不小于 0 的金额', {
      cardId: row.id,
      category,
      amount: input?.amount,
    });
  }

  // Replace semantics: a card+category keeps exactly ONE limit row. The delete and the create run
  // in ONE transaction, so a failure can never leave the category without its limit.
  await runInTransaction(async (tx) => {
    await tx.cardLimit.deleteMany({ where: { cardId: row.id, category } });
    await tx.cardLimit.create({ data: { cardId: row.id, category, amount } });
  });

  return loadCardView(row);
}

/** Freeze a card (status → FROZEN); returns the updated card. */
export async function freezeCard(cardId: string): Promise<CardView> {
  const row = await requireCard(cardId);
  const updated = await transitionTo(row, 'FROZEN', ['ACTIVE', 'PENDING']);
  return loadCardView(updated);
}

/** Unfreeze a card (status → ACTIVE); returns the updated card. */
export async function unfreezeCard(cardId: string): Promise<CardView> {
  const row = await requireCard(cardId);
  // Only a FROZEN card can be unfrozen; an ACTIVE one is a no-op, a LOST one may not be revived.
  const updated = await transitionTo(row, 'ACTIVE', ['FROZEN']);
  return loadCardView(updated);
}

/**
 * Report a card lost (status → LOST); returns the updated card.
 * The optional `reason` is accepted for API compatibility; the demo schema stores no reason column
 * (the calling layer captures it in the audit record).
 */
export async function reportLostCard(
  cardId: string,
  input: ReportLostCardInput = {},
): Promise<CardView> {
  const row = await requireCard(cardId);
  const reason = typeof input?.reason === 'string' ? input.reason.trim() || undefined : undefined;
  if ((row.status as CardStatus) === 'LOST') {
    throw new AppError('CONFLICT', '该卡片已挂失，无需重复挂失', {
      cardId: row.id,
      status: row.status,
      reason,
    });
  }
  const updated = await cards.updateCardStatus(row.id, 'LOST');
  return loadCardView(updated);
}

/**
 * Issue a new virtual card; returns the created card.
 * `input.label` is accepted for API compatibility but not persisted (no label column in the demo
 * schema). The masked number is generated as `****` + 4 digits, avoiding the user's existing masks.
 */
export async function applyVirtualCard(input: ApplyVirtualCardInput): Promise<CardView> {
  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') {
    throw new AppError('VALIDATION', '缺少用户 id', { userId: input?.userId });
  }

  const existing = await cards.listCards(userId);
  const numberMasked = generateMaskedNumber(new Set(existing.map((card) => card.numberMasked)));

  const row = await cards.createCard({
    userId,
    type: 'VIRTUAL',
    network: VIRTUAL_CARD_NETWORK,
    numberMasked,
    status: 'ACTIVE',
  });

  // A brand-new card carries no per-category limits.
  return toCardView(row, []);
}

/**
 * Build a masked card number (`****` + 4 random digits) that does not collide with any of the
 * user's existing masks. Throws `AppError('INTERNAL')` if that proves impossible (never silently
 * returns a duplicate).
 */
function generateMaskedNumber(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const masked = `****${suffix}`;
    if (!existing.has(masked)) return masked;
  }
  throw new AppError('INTERNAL', '无法生成唯一的虚拟卡卡号', { attempts: 20 });
}
