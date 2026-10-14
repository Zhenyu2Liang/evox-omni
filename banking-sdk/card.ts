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
 *
 * `applyVirtualCard` accepts an OPTIONAL `idempotencyKey`: when supplied, the card id is derived
 * deterministically from `(userId, key)` and a repeat replays the existing card instead of issuing a
 * second one (a plan node can be replayed after a resume/retry — see `./idempotent.ts`).
 */
import type { Card as CardRow, CardLimit as CardLimitRow } from '@/lib/db/prisma';
import { cards } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { centsToMoney, moneyToCents } from '../lib/money';
import { idempotentCardId, isUniqueViolation, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction } from './tx';
import type { AddDemoCardRequest } from '../lib/contracts/card-management';
import { safeParse } from '../lib/json';
import { SPENDING_CATEGORIES } from './categories';
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
    creditLimit: row.creditLimitMinor === null ? undefined : centsToMoney(row.creditLimitMinor),
    availableLimit: row.availableLimitMinor === null ? undefined : centsToMoney(row.availableLimitMinor),
    monthlyLimit: row.monthlyLimitMinor === null ? undefined : centsToMoney(row.monthlyLimitMinor),
    limits: limits.map((limit) => ({ category: limit.category, amount: centsToMoney(limit.amountMinor) })),
  };
}

/** Map a card row onto a `CardView`, loading its per-category limits. */
async function loadCardView(row: CardRow): Promise<CardView> {
  return toCardView(row, await cards.listCardLimits(row.id));
}

/** Resolve a card or throw `AppError('NOT_FOUND')`. */
async function requireCard(cardId: string, userId: string): Promise<CardRow> {
  if (typeof userId !== 'string' || !userId.trim()) throw new AppError('SECURITY_DENIED', '缺少卡片操作用户身份。');
  const row = typeof cardId === 'string' && cardId.length > 0 ? await cards.getCard(cardId) : null;
  if (!row) throw new AppError('NOT_FOUND', `卡片不存在：${String(cardId)}`, { cardId });
  if (row.userId !== userId) throw new AppError('SECURITY_DENIED', '无权操作该卡片。');
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
  return runInTransaction(async tx => {
    const latest = await tx.card.findUnique({ where: { id: row.id, userId: row.userId } });
    if (!latest) throw new AppError('NOT_FOUND', 'Card does not exist.');
    const current = latest.status as CardStatus;
    if (current === next) return latest;
    if (!allowedFrom.includes(current)) {
      throw new AppError('CONFLICT', 'The card state does not allow this transition.', { cardId: row.id, from: current, to: next });
    }
    const updated = await tx.card.updateMany({ where: { id: row.id, userId: row.userId, status: current }, data: { status: next } });
    const committed = await tx.card.findUnique({ where: { id: row.id, userId: row.userId } });
    if (!committed) throw new AppError('NOT_FOUND', 'Card does not exist.');
    if (updated.count === 0 && committed.status !== next) {
      throw new AppError('CONFLICT', 'The card state changed before the operation committed.', { cardId: row.id, status: committed.status });
    }
    return committed;
  });
}

/** All cards owned by the user (with per-category limits). */
export async function getCards(userId: string): Promise<CardView[]> {
  return runInTransaction(async () => {
    const rows = await cards.listCards(userId);
    return Promise.all(rows.map(loadCardView));
  });
}

/** Create a simulated record only; the dedicated manual command owns MFA, audit and replay. */
export async function addDemoCard(userId: string, input: Omit<AddDemoCardRequest, 'requestId'>): Promise<CardView> {
  if (!['DEBIT', 'CREDIT', 'VIRTUAL'].includes(input.type)) throw new AppError('VALIDATION', 'Invalid card type.');
  const creditLimitMinor = input.creditLimit === undefined ? null : moneyToCents(input.creditLimit);
  const monthlyLimitMinor = input.monthlyLimit === undefined ? null : moneyToCents(input.monthlyLimit);
  if (input.type === 'CREDIT' && (creditLimitMinor === null || creditLimitMinor <= 0n)) throw new AppError('VALIDATION', 'A credit card requires a positive credit limit.');
  if (input.type !== 'CREDIT' && creditLimitMinor !== null) throw new AppError('VALIDATION', 'Only credit cards accept a credit limit.');
  if (monthlyLimitMinor !== null && monthlyLimitMinor < 0n) throw new AppError('VALIDATION', 'Monthly limit must be non-negative.');
  return runInTransaction(async tx => {
    const own = await tx.card.findMany({ where: { userId } });
    const row = await tx.card.create({ data: { userId, type: input.type, network: 'UnionPay',
      numberMasked: generateMaskedNumber(new Set(own.map(card => card.numberMasked))), status: 'ACTIVE',
      creditLimitMinor, availableLimitMinor: creditLimitMinor, monthlyLimitMinor } });
    return toCardView(row, []);
  });
}

/** Read-only eligibility check, repeated inside the serialized deletion transaction. */
export async function assertDemoCardDeletable(userId: string, cardId: string, ownActionId: string): Promise<CardView> {
  return runInTransaction(async tx => {
    const row = await requireCard(cardId, userId);
    if (row.type === 'CREDIT' && (row.creditLimitMinor === null || row.availableLimitMinor === null || row.creditLimitMinor !== row.availableLimitMinor)) {
      throw new AppError('CONFLICT', 'A card with outstanding or unknown credit obligations cannot be deleted.');
    }
    const referencesCard = (json: string | null): boolean => {
      const visit = (value: unknown): boolean => {
        if (typeof value === 'string') return value === cardId || value === row.numberMasked || value === row.numberMasked.slice(-4);
        if (Array.isArray(value)) return value.some(visit);
        if (value && typeof value === 'object') return Object.values(value).some(visit);
        return false;
      };
      return visit(safeParse(json ?? '', null));
    };
    const actions = await tx.pendingAction.findMany({ where: { userId, id: { not: ownActionId },
      status: { in: ['pending', 'awaiting_mfa', 'confirmed', 'locked', 'needs_reconciliation'] } } });
    const invocations = await tx.toolInvocation.findMany({ where: { run: { userId },
      status: { in: ['started', 'waiting_confirmation', 'waiting_verification', 'interrupted', 'needs_reconciliation'] } } });
    const nodes = await tx.agentTaskNode.findMany({ where: { task: { userId, status: { notIn: ['completed', 'cancelled'] } },
      status: { notIn: ['success', 'completed', 'cancelled', 'skipped'] } } });
    const generating = await tx.agentRun.count({ where: { userId, status: { in: ['running', 'interrupted'] } } });
    const runningPlans = await tx.agentTask.count({ where: { userId, status: { in: ['running', 'pending'] } } });
    if (generating > 0 || runningPlans > 0 || actions.some(action => action.status === 'needs_reconciliation' || referencesCard(action.argsJson)) ||
        invocations.some(invocation => invocation.status === 'needs_reconciliation' || referencesCard(invocation.argsJson)) ||
        nodes.some(node => referencesCard(node.args))) {
      throw new AppError('CONFLICT', 'Resolve pending or uncertain operations involving this card before deleting it.');
    }
    return loadCardView(row);
  });
}

/** Delete a simulated card while preserving the ledger, immutable receipts and audit history. */
export async function deleteDemoCard(userId: string, cardId: string, ownActionId: string): Promise<CardView> {
  return runInTransaction(async tx => {
    const view = await assertDemoCardDeletable(userId, cardId, ownActionId);
    await tx.cardLimit.deleteMany({ where: { cardId } });
    await tx.card.delete({ where: { id: cardId, userId } });
    return view;
  });
}

/** Set/replace the per-category spend limit on a card; returns the updated card. */
export async function setCardLimit(input: SetCardLimitInput): Promise<CardView> {
  const row = await requireCard(input?.cardId, input?.userId);

  const category = typeof input?.category === 'string' ? input.category.trim() : '';
  if (category === '') {
    throw new AppError('VALIDATION', '缺少限额分类', { cardId: row.id, category: input?.category });
  }
  if (!(SPENDING_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError('VALIDATION', 'Card limit category must be a supported spending category.');
  }
  const amountMinor = moneyToCents(input?.amount);
  if (amountMinor < 0n) {
    throw new AppError('VALIDATION', '限额必须是不小于 0 的金额', {
      cardId: row.id,
      category,
      amount: input?.amount,
    });
  }

  // Replace semantics: a card+category keeps exactly ONE limit row. The delete and the create run
  // in ONE transaction, so a failure can never leave the category without its limit.
  return runInTransaction(async (tx) => {
    const current = await tx.card.findUnique({ where: { id: row.id, userId: input.userId } });
    if (!current) throw new AppError('NOT_FOUND', 'Card does not exist.');
    if (current.status !== 'ACTIVE' && current.status !== 'FROZEN') {
      throw new AppError('CONFLICT', 'Only active or frozen cards support category limit changes.', { cardId: row.id, status: current.status });
    }
    await tx.cardLimit.deleteMany({ where: { card: { id: row.id, userId: input.userId }, category } });
    await tx.cardLimit.create({ data: { card: { connect: { id: row.id, userId: input.userId } }, category, amountMinor } });
    return toCardView(current, await tx.cardLimit.findMany({ where: { cardId: row.id } }));
  });
}

/** Freeze a card (status → FROZEN); returns the updated card. */
export async function freezeCard(cardId: string, userId: string): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  const updated = await transitionTo(row, 'FROZEN', ['ACTIVE', 'PENDING']);
  return loadCardView(updated);
}

/** Unfreeze a card (status → ACTIVE); returns the updated card. */
export async function unfreezeCard(cardId: string, userId: string): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  // Only a FROZEN card can be unfrozen; an ACTIVE one is a no-op, a LOST one may not be revived.
  const updated = await transitionTo(row, 'ACTIVE', ['FROZEN']);
  return loadCardView(updated);
}

/**
 * Report a card lost (status → LOST); returns the updated card.
 * The calling layer records the optional reason in the audit trail.
 */
export async function reportLostCard(
  cardId: string,
  userId: string,
  input: ReportLostCardInput = {},
): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new AppError('VALIDATION', 'Loss reporting reason must be text.');
  }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() || undefined : undefined;
  if ((row.status as CardStatus) === 'LOST') {
    throw new AppError('CONFLICT', '该卡片已挂失，无需重复挂失', {
      cardId: row.id,
      status: row.status,
      reason,
    });
  }
  const updated = await runInTransaction(async tx => {
    const result = await tx.card.updateMany({ where: { id: row.id, userId, status: row.status }, data: { status: 'LOST' } });
    if (result.count !== 1) throw new AppError('CONFLICT', 'The card state changed before loss reporting committed.');
    return tx.card.findUniqueOrThrow({ where: { id: row.id, userId } });
  });
  return loadCardView(updated);
}

/**
 * Issue a new virtual card; returns the created card.
 * The masked number is generated as `****` + 4 digits, avoiding the user's existing masks.
 * `monthlyLimit` is an explicit cent-valid configuration saved at creation (no card-payment API).
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, the card id is derived
 * deterministically from `(userId, key)` and reused as the primary key, so a repeat of the SAME key
 * finds and REPLAYS the original card (same `id`) instead of issuing a SECOND virtual card.
 * Concurrent same-key calls are safe too — the loser's insert violates the PK, its transaction rolls
 * back (no card written), then the winner's committed card is replayed. Absent → unchanged behavior.
 */
export async function applyVirtualCard(input: ApplyVirtualCardInput): Promise<CardView> {
  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') {
    throw new AppError('VALIDATION', '缺少用户 id', { userId: input?.userId });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const cents = input.monthlyLimit === undefined ? undefined : moneyToCents(input.monthlyLimit);
  if (cents !== undefined && cents < 0n) throw new AppError('VALIDATION', 'Monthly limit must be non-negative.');
  const monthlyLimitMinor = cents;
  const replay = (card: CardRow): CardRow => {
    if (card.userId !== userId || card.type !== 'VIRTUAL') {
      throw new AppError('CONFLICT', 'The execution identity does not belong to this virtual card issuance.');
    }
    if (card.monthlyLimitMinor !== (monthlyLimitMinor ?? null)) {
      throw new AppError('CONFLICT', '同一幂等身份不能申请不同月限额的虚拟卡。');
    }
    return card;
  };
  if (key === undefined) {
    const existing = await cards.listCards(userId);
    const numberMasked = generateMaskedNumber(new Set(existing.map((card) => card.numberMasked)));

    const row = await runInTransaction((tx) => tx.card.create({ data: {
      userId,
      type: 'VIRTUAL',
      network: VIRTUAL_CARD_NETWORK,
      numberMasked,
      status: 'ACTIVE',
      monthlyLimitMinor,
    } }));

    // A brand-new card carries no per-category limits.
    return toCardView(row, []);
  }

  // Deterministic-id replay (the `Card` table has no idempotencyKey column): the create goes
  // through `runInTransaction` so the derive-find-create sequence is all-or-nothing, mirroring
  // `setCardLimit`'s in-transaction use of `tx.card*`.
  const cardId = idempotentCardId(userId, key);
  let row: CardRow;
  try {
    row = await runInTransaction(async (tx): Promise<CardRow> => {
      const replayed = await tx.card.findUnique({ where: { id: cardId } });
      if (replayed) return replay(replayed);

      const own = await tx.card.findMany({ where: { userId } });
      const numberMasked = generateMaskedNumber(new Set(own.map((card) => card.numberMasked)));

      return tx.card.create({
        data: {
          id: cardId,
          userId,
          type: 'VIRTUAL',
          network: VIRTUAL_CARD_NETWORK,
          numberMasked,
          status: 'ACTIVE',
          monthlyLimitMinor,
        },
      });
    });
  } catch (error) {
    // Concurrent same-key race: the other call committed the card first → our tx rolled back (no
    // card written). Re-read the committed card and replay it.
    if (isUniqueViolation(error)) {
      const committed = await cards.getCard(cardId);
      if (committed) return loadCardView(replay(committed));
    }
    throw error;
  }

  return loadCardView(row);
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
