/**
 * Unit: `security/card-resolution` — SERVER-SIDE card-target resolution at PARK time.
 *
 * Every card mutation used to accept ONLY a raw `cardId`, so the model had to guess an id and a user
 * saying「我的借记卡」or「尾号6688」could not be served at all. This module is the server-side
 * "user words → card" layer, and these tests pin its contract directly (DB-backed, no gateway):
 *
 *   - `cardId`     exact id of ONE of the caller's own cards (never re-interpreted as a tail/number);
 *   - `cardType`   `DEBIT|CREDIT|VIRTUAL` (case-insensitive) or a Chinese synonym 借记卡/储蓄卡/信用卡/虚拟卡;
 *   - `cardTail`   EXACTLY four trailing digits, written `6688` / `尾号6688` / `****6688` / `...6688`;
 *   - `cardNumber` the COMPLETE fictional number (server-only `numberFull`, exact equality only).
 *
 * A supplied selector that cannot be normalized is `invalid` BEFORE any lookup; every supplied selector
 * must match the SAME owned card; 1 candidate ⇒ `resolved`, 0 ⇒ `not_found`, >1 ⇒ `ambiguous` with
 * `id`/`type`/`numberMasked` candidates only; other users' cards are invisible (`not_found`, never a
 * leak); a tail or complete number placed in `cardId` is an explicit `invalid` refusal.
 *
 * `canonicalizeCardArgs` keeps every other argument and leaves ONLY the resolved `cardId`, and
 * `buildCardClarifyMessage` never emits a 12–19 digit run (a complete number is server-only).
 *
 * Fixtures (`tests/helpers/fixtures.ts`): 李明 owns `card_credit` (****6688) and `card_debit` (****8821);
 * the seed ships NO virtual card, and every extra/foreign card this file needs is created here through
 * Prisma so the shared fixture dataset stays untouched.
 */
import { describe, expect, it, vi } from 'vitest';

import { maskCardNumber } from '@/lib/mask';
import { moneyToCents } from '@/lib/money';
import {
  buildCardClarifyMessage,
  canonicalizeCardArgs,
  cardTypeLabel,
  resolveCardTarget,
  type CardResolution,
} from '@/security/card-resolution';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// The per-test `resetDatabase()` + seed is I/O heavy and can exceed the 10 s default hook timeout.
vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/* --------------------------------------------------------------- fixture ids */

/** The seeded CREDIT card (****6688 ≤ 6222000000006688). */
const CREDIT_ID = 'card_credit';
const CREDIT_MASKED = '****6688';
const CREDIT_FULL = '6222000000006688';
/** The seeded DEBIT card (****8821 — the ONLY debit card, bound to `acct_checking`). */
const DEBIT_ID = 'card_debit';
const DEBIT_MASKED = '****8821';
const DEBIT_FULL = '6222000000008821';
/** A second user, created only to prove owner isolation. */
const OTHER_USER_ID = 'user_other';
const FOREIGN_CARD_ID = 'card_foreign';
const FOREIGN_MASKED = '****4321';
const FOREIGN_FULL = '6222000000004321';

/** Any 12–19 digit run — the shape of a COMPLETE card number that must never be emitted. */
const COMPLETE_NUMBER_SHAPE = /\d{12,19}/;

/* ------------------------------------------------------------------ helpers */

/** Resolve a selector set for the demo user. */
function resolve(args: Record<string, unknown>): Promise<CardResolution> {
  return resolveCardTarget(DEMO_USER_ID, args);
}

/** Resolve and REQUIRE a single match, narrowing the union for the assertions. */
async function resolvedCard(args: Record<string, unknown>) {
  const res = await resolve(args);
  if (res.status !== 'resolved') {
    throw new Error(`expected a resolved card, got ${JSON.stringify(res)}`);
  }
  return res.card;
}

/** The model-readable clarification of a non-resolved outcome. */
function clarifyMessage(res: CardResolution): string {
  if (res.status === 'resolved') throw new Error('a resolved target needs no clarification');
  return buildCardClarifyMessage(res);
}

/** Create a card directly (the shared fixture dataset must not grow for one test). */
function createCard(card: {
  id: string;
  userId?: string;
  type: 'DEBIT' | 'CREDIT' | 'VIRTUAL';
  numberMasked: string;
  numberFull: string;
  linkedAccountId?: string;
  monthlyLimit?: string;
}): Promise<unknown> {
  return getTestPrisma().card.create({
    data: {
      id: card.id,
      userId: card.userId ?? DEMO_USER_ID,
      type: card.type,
      network: 'UnionPay',
      numberMasked: card.numberMasked,
      numberFull: card.numberFull,
      status: 'ACTIVE',
      ...(card.linkedAccountId === undefined ? {} : { linkedAccountId: card.linkedAccountId }),
      ...(card.monthlyLimit === undefined ? {} : { monthlyLimitMinor: moneyToCents(card.monthlyLimit) }),
    },
  });
}

/** A user + one CREDIT card the demo user does not own. */
async function seedForeignCard(): Promise<void> {
  await getTestPrisma().user.create({
    data: { id: OTHER_USER_ID, name: '他人', phone: '137****9999', avatarEmoji: '🧑' },
  });
  await createCard({
    id: FOREIGN_CARD_ID,
    userId: OTHER_USER_ID,
    type: 'CREDIT',
    numberMasked: FOREIGN_MASKED,
    numberFull: FOREIGN_FULL,
  });
}

/* =================================================================== (a) 唯一匹配 */

describe('card-resolution · 唯一匹配的选择器 → resolved', () => {
  it('「我的借记卡」：cardType 的 DEBIT∨借记卡∨储蓄卡 都唯一定位到唯一借记卡', async () => {
    for (const value of ['DEBIT', 'debit', '借记卡', '储蓄卡']) {
      const card = await resolvedCard({ cardType: value });
      expect(card).toEqual({ id: DEBIT_ID, type: 'DEBIT', numberMasked: DEBIT_MASKED });
    }
  });

  it('「信用卡尾号6688」：cardType+cardTail 组合命中，尾号可写 6688∨尾号6688∨****6688', async () => {
    for (const tail of ['6688', '尾号6688', '****6688', '...6688']) {
      const card = await resolvedCard({ cardType: 'CREDIT', cardTail: tail });
      expect(card).toEqual({ id: CREDIT_ID, type: 'CREDIT', numberMasked: CREDIT_MASKED });
    }
    // 中文类型同样被接受（大小写不敏感，同义词映射到 wire 值）。
    expect((await resolvedCard({ cardType: '信用卡', cardTail: '6688' })).id).toBe(CREDIT_ID);
  });

  it('完整卡号精确命中（服务端专用 numberFull），空格/短横线分隔的同一号码同样命中', async () => {
    expect((await resolvedCard({ cardNumber: CREDIT_FULL })).id).toBe(CREDIT_ID);
    expect((await resolvedCard({ cardNumber: '6222 0000 0000 6688' })).id).toBe(CREDIT_ID);
    expect((await resolvedCard({ cardNumber: '6222-0000-0000-8821' })).id).toBe(DEBIT_ID);
  });

  it('中间四位不同的完整卡号 → not_found（绝不只是比后四位）', async () => {
    for (const number of ['6222000000009999', '6222 0000 0000 9999']) {
      const res = await resolve({ cardNumber: number });
      expect(res.status).toBe('not_found');
      // 后四位相同也不构成身份：clarify 文案绝不带出完整卡号。
      expect(clarifyMessage(res)).not.toMatch(COMPLETE_NUMBER_SHAPE);
    }
  });

  it('只有 id 的调用（模型已拿到 get_cards 的 id）依旧精确命中', async () => {
    expect((await resolvedCard({ cardId: CREDIT_ID })).id).toBe(CREDIT_ID);
    expect((await resolvedCard({ cardId: DEBIT_ID, cardType: '借记卡' })).id).toBe(DEBIT_ID);
  });

  it('候选/澄清只携带脱敏卡号，完整卡号从不出现', async () => {
    const card = await resolvedCard({ cardType: 'CREDIT' });
    expect(Object.keys(card).sort()).toEqual(['id', 'numberMasked', 'type']);
    expect(card.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(JSON.stringify(card)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });
});

/* =================================================================== (b) 多候选 */

describe('card-resolution · 多候选必须澄清（ambiguous）', () => {
  it('同类型第二张卡 → ambiguous，候选只含 id/type/numberMasked', async () => {
    await createCard({
      id: 'card_credit_2',
      type: 'CREDIT',
      numberMasked: '****1234',
      numberFull: '6222000000001234',
    });

    const res = await resolve({ cardType: 'CREDIT' });

    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.kind).toBe('cardType');
    expect(res.supplied).toBe('CREDIT');
    expect(res.candidates.map((c) => c.id).sort()).toEqual(['card_credit', 'card_credit_2']);
    for (const candidate of res.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['id', 'numberMasked', 'type']);
      expect(candidate.numberMasked).toMatch(/^\*{4}\d{4}$/);
    }
    // 两张都被点名，且都只有脱敏号。
    const message = clarifyMessage(res);
    expect(message).toContain(CREDIT_MASKED);
    expect(message).toContain('****1234');
    expect(message).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('共享尾号（两张卡都 …8821）→ ambiguous，不擅自挑一张', async () => {
    await createCard({
      id: 'card_debit_2',
      type: 'DEBIT',
      numberMasked: '****8821',
      numberFull: '6223000000008821',
    });

    const res = await resolve({ cardTail: '尾号8821' });

    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.candidates.map((c) => c.id).sort()).toEqual(['card_debit', 'card_debit_2']);
    expect(clarifyMessage(res)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('只用一个共享尾号即可澄清，但组合 cardType 后重新唯一', async () => {
    await createCard({
      id: 'card_debit_2',
      type: 'DEBIT',
      numberMasked: '****8821',
      numberFull: '6223000000008821',
    });
    // 尾号 8821 命中两张借记卡；加上完整卡号后只命中一张。
    expect((await resolve({ cardTail: '8821' })).status).toBe('ambiguous');
    const unique = await resolvedCard({ cardTail: '8821', cardNumber: DEBIT_FULL });
    expect(unique.id).toBe(DEBIT_ID);
  });
});

/* =========================================================== (c) 冲突与非法值 */

describe('card-resolution · 组合冲突与非法选择器', () => {
  it('类型与尾号互相矛盾（信用卡 + 尾号8821）→ not_found', async () => {
    const res = await resolve({ cardType: 'CREDIT', cardTail: '8821' });

    expect(res.status).toBe('not_found');
    if (res.status !== 'not_found') return;
    expect(res.kind).toBe('cardType');
    expect(clarifyMessage(res)).toContain('未能找到');
    expect(clarifyMessage(res)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('无法识别的卡片类型（储蓄卡吧）→ invalid，不做任何查询', async () => {
    const res = await resolve({ cardType: '储蓄卡吧' });

    expect(res.status).toBe('invalid');
    if (res.status !== 'invalid') return;
    expect(res.detail).toContain('无法识别的卡片类型');
    expect(res.detail).toContain('储蓄卡吧');
  });

  it('不是 4 位的尾号 → invalid', async () => {
    for (const tail of ['668', '66888', 'abcd']) {
      const res = await resolve({ cardTail: tail });
      expect(res.status).toBe('invalid');
    }
  });

  it('不合法的完整卡号（非 12-19 位）→ invalid', async () => {
    for (const number of ['6688', '62220000000066886666', 'not-a-number']) {
      const res = await resolve({ cardNumber: number });
      expect(res.status).toBe('invalid');
    }
  });

  it('完全没有选择器 → invalid', async () => {
    for (const args of [{}, { cardId: '' }, { cardType: '  ' }, { cardType: undefined }]) {
      const res = await resolve(args as Record<string, unknown>);
      expect(res.status).toBe('invalid');
    }
  });

  it('既不存在的 id 也不是尾号形状 → not_found（不是 invalid）', async () => {
    const res = await resolve({ cardId: 'card_nonexistent' });
    expect(res.status).toBe('not_found');
  });
});

/* ================================================== (d) 尾号/卡号当 cardId 的拒绝 */

describe('card-resolution · 尾号或完整卡号被放进 cardId → 明确拒绝', () => {
  it("cardId 里的 '6688' / '****6688' / 完整卡号一律 invalid，绝不解析成任何卡", async () => {
    for (const value of ['6688', '****6688', '尾号6688', '...6688', CREDIT_FULL]) {
      const res = await resolve({ cardId: value });

      expect(res.status).toBe('invalid');
      if (res.status !== 'invalid') return;
      expect(res.detail).toContain('不能把尾号或卡号当作卡片 id');
      // 拒绝文案本身不得回显任何卡号形状。
      expect(res.detail).not.toMatch(COMPLETE_NUMBER_SHAPE);
      expect(JSON.stringify(res)).not.toContain(CREDIT_MASKED);
    }
  });

  it('合法的 id 与形状可疑的 id 互不混淆：card_credit 仍然 resolved', async () => {
    expect((await resolvedCard({ cardId: CREDIT_ID })).id).toBe(CREDIT_ID);
    expect((await resolve({ cardId: '6688' })).status).toBe('invalid');
  });
});

/* ================================================================ (e) 他人卡片 */

describe('card-resolution · 他人卡片不可解析、不泄漏', () => {
  it('他人的 cardId / cardTail → not_found，且不投影任何候选或脱敏号', async () => {
    await seedForeignCard();

    for (const args of [{ cardId: FOREIGN_CARD_ID }, { cardTail: '4321' }]) {
      const res = await resolve(args);

      expect(res.status).toBe('not_found');
      // No card and no candidate list is projected at all → nothing about the foreign card is exposed.
      expect('card' in res).toBe(false);
      expect('candidates' in res).toBe(false);
      expect(JSON.stringify(res)).not.toContain(`"${FOREIGN_MASKED}"`);
      expect(clarifyMessage(res)).not.toContain(FOREIGN_MASKED);
      expect(clarifyMessage(res)).not.toMatch(COMPLETE_NUMBER_SHAPE);
    }
  });

  it('他人的完整卡号 → not_found（服务端从不拿 numberFull 匹配他人卡），澄清只回显脱敏形式', async () => {
    await seedForeignCard();

    const res = await resolve({ cardNumber: FOREIGN_FULL });

    expect(res.status).toBe('not_found');
    expect('card' in res).toBe(false);
    expect('candidates' in res).toBe(false);
    const message = clarifyMessage(res);
    // The mask of the CALLER-SUPPLIED value is echoed; no projection of the foreign card is added.
    expect(message).toContain(maskCardNumber(FOREIGN_FULL));
    expect(message).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('他人卡片不会让本人的唯一匹配变成 ambiguous（候选集只有本人卡片）', async () => {
    await seedForeignCard();

    expect((await resolvedCard({ cardType: 'CREDIT' })).id).toBe(CREDIT_ID);
    expect((await resolvedCard({ cardTail: '6688' })).id).toBe(CREDIT_ID);
  });
});

/* ============================================================ (f) 规范化与文案 */

describe('card-resolution · canonicalizeCardArgs / buildCardClarifyMessage', () => {
  it('只留 cardId，删除 cardType/cardTail/cardNumber，其余参数原样保留', () => {
    const canonical = canonicalizeCardArgs(
      {
        cardType: 'CREDIT',
        cardTail: '尾号6688',
        cardNumber: CREDIT_FULL,
        category: '娱乐',
        amount: '3000.00',
        merchant: '本地咖啡店',
      },
      CREDIT_ID,
    );

    expect(canonical).toEqual({
      cardId: CREDIT_ID,
      category: '娱乐',
      amount: '3000.00',
      merchant: '本地咖啡店',
    });
    expect('cardType' in canonical).toBe(false);
    expect('cardTail' in canonical).toBe(false);
    expect('cardNumber' in canonical).toBe(false);
    expect(JSON.stringify(canonical)).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('已有的（不正确或残留的）cardId 会被解析结果覆盖', () => {
    expect(canonicalizeCardArgs({ cardId: DEBIT_ID, cardTail: '6688' }, CREDIT_ID)).toEqual({
      cardId: CREDIT_ID,
    });
  });

  it('澄清文案把模糊的完整卡号换成脱敏号（不含任何 12-19 位数字）', async () => {
    const res = await resolve({ cardNumber: '6222000000009999' });

    expect(res.status).toBe('not_found');
    if (res.status !== 'not_found') return;
    // The FIRST supplied selector is what the message echoes — here the complete number itself.
    expect(res.supplied).toBe('6222000000009999');
    const message = clarifyMessage(res);
    expect(message).toContain(maskCardNumber('6222000000009999'));
    expect(message).not.toMatch(COMPLETE_NUMBER_SHAPE);
  });

  it('类型标签用于确认摘要：DEBIT/CREDIT/VIRTUAL → 借记卡/信用卡/虚拟卡', () => {
    expect(cardTypeLabel('DEBIT')).toBe('借记卡');
    expect(cardTypeLabel('CREDIT')).toBe('信用卡');
    expect(cardTypeLabel('VIRTUAL')).toBe('虚拟卡');
  });
});
