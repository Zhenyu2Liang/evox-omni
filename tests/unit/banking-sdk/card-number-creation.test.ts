/**
 * banking-sdk · 新建卡片写入「服务端虚构完整卡号」(`numberFull`) 的回归覆盖。
 *
 * `security/card-resolution.ts` 的 `cardNumber` 选择器只按完整卡号做**精确相等**匹配，而它读的是服务端
 * 专列 `Card.numberFull`。历史行（seed / fixtures）已经带了 0000 号段的虚构完整号，但**运行时新建**的卡片
 * （虚拟卡申请、补办换卡、demo 加卡）曾只写 `numberMasked`，于是新卡永远无法用完整卡号选中。本文件锁定修复
 * 后的契约：
 *
 *   1. `applyVirtualCard` / `replaceCard` / `addDemoCard` 造出的每一张新卡都同时写入 `numberFull`：
 *      `6222` + 8 个 `0` + 尾四位 = 16 位数字（例 `6222000000001234`）——**明确虚构**的测试号段，
 *      绝不使用真实银行卡号；
 *   2. `numberMasked` 由同一个完整卡号经 `lib/mask.ts#maskCardNumber` 推导（`****1234` 形态不变），
 *      二者尾四位一致、绝不各算一份；
 *   3. 新卡可被 `cardNumber` 精确解析；中间 `0000` 段换成别的数字则 `not_found`；
 *   4. 连续新建两张卡尾四位与完整号互不相同，`cardTail` 各自唯一解析（既有唯一性契约不退化）；
 *   5. 完整卡号**永不外泄**：`CardView` 投影、建卡工具结果、以及 demo 加卡的审计/动作文本里都不出现
 *      12–19 位连续数字。
 *
 * 既不回填也不改写既有行：seed/fixtures 的既有尾号（6688 / 8821 / 7788）与既有断言因此继续成立。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { getDemoSession } from '@/agent';
import { runApplyVirtualCard, runReplaceCard } from '@/agent/tools/card';
import { banking } from '@/banking-sdk';
import type { CardView } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { maskCardNumber } from '@/lib/mask';
import { resolveCardTarget } from '@/security/card-resolution';
import { proposeCardChange, verifyCardChange } from '@/security/manual-card-management';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();
vi.setConfig({ hookTimeout: 60_000 });

const db = () => getTestPrisma();

/** 借记卡源卡（尾号 8821，绑定 `acct_checking`）— 补办换卡路径的起点。 */
const DEBIT = 'card_debit';
/** 信用卡（尾号 6688）— 尾号唯一性用例里"被占用"的那张卡。 */
const CREDIT = 'card_credit';
/** 唯一的 CHECKING 结算账户。 */
const CHECKING_ACCOUNT_ID = 'acct_checking';

/** 虚构完整卡号形态：`6222` + 8 个 `0` + 尾四位 = 16 位数字。 */
const FICTIONAL_COMPLETE = /^6222(0{8})(\d{4})$/;
/** 12–19 位连续数字 = 完整卡号的形态：任何对外投影、摘要、审计/事件文本都不得出现。 */
const COMPLETE_NUMBER_SHAPE = /\d{12,19}/;

/** 直接读库取服务端完整卡号 —— 只有测试能看见它（任何对外投影都没有这个字段）。 */
async function readFullNumber(cardId: string): Promise<string> {
  const row = await db().card.findUniqueOrThrow({ where: { id: cardId } });
  if (typeof row.numberFull !== 'string') throw new Error(`卡片 ${cardId} 没有记录服务端完整卡号 numberFull`);
  return row.numberFull;
}

/**
 * 断言一个新造出来的卡片满足「虚构完整号 + 由其推导的脱敏值」：形态、尾四位一致、
 * `numberMasked === maskCardNumber(同一号码的尾窗口)`。返回该完整卡号供后续断言使用。
 */
async function expectFictionalIdentity(view: CardView): Promise<string> {
  const numberFull = await readFullNumber(view.id);
  const match = FICTIONAL_COMPLETE.exec(numberFull);
  expect(match).not.toBeNull();
  // `6222` + 全 `0` 中间段 ⇒ 16 位、且中间 8 位必须全为 `0`
  expect(numberFull).toHaveLength(16);
  expect(numberFull.slice(4, 12)).toBe('00000000');
  expect(numberFull.slice(-4)).toBe(view.numberMasked.slice(-4));
  // 展示值必须由同一个完整卡号推导，而不是另算一份脱敏（`****1234` 的 8 字符形态保持不变）。
  expect(view.numberMasked).toBe(maskCardNumber(numberFull.slice(-8)));
  expect(view.numberMasked).toMatch(/^\*{4}\d{4}$/);
  return numberFull;
}

/**
 * 扫描序列化文本里是否出现完整卡号形态。服务端不透明 id（cuid / sha256 摘要）本身可能偶含 12–19 位
 * 连续数字，那是指标身份而非卡号，扫描前先置空，避免把 id 误判成泄漏。
 */
function expectNoCompleteNumber(
  text: string,
  opaqueIds: readonly (string | null | undefined)[] = [],
): void {
  let scrubbed = text;
  for (const id of opaqueIds) {
    if (typeof id === 'string' && id.length >= 8) scrubbed = scrubbed.split(id).join('<opaque-id>');
  }
  expect(scrubbed).not.toMatch(COMPLETE_NUMBER_SHAPE);
}

describe('banking-sdk · 新建卡片写入虚构完整卡号', () => {
  it('虚拟卡申请：写入 6222+0000 段的 16 位虚构号，展示值由同一号码推导', async () => {
    const view = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: '500.00' });

    const numberFull = await expectFictionalIdentity(view);
    expect(view.type).toBe('VIRTUAL');
    // 既有行为不变：虚拟卡仍绑定唯一的 CHECKING 结算账户。
    expect(view.linkedAccountId).toBe(CHECKING_ACCOUNT_ID);
    expect(numberFull).not.toBe('6222000000006688');
  });

  it('cardNumber 选择器：完整号精确命中新卡；中间段不同则 not_found', async () => {
    const view = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID });
    const numberFull = await expectFictionalIdentity(view);

    expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: numberFull })).toMatchObject({
      status: 'resolved',
      card: { id: view.id, type: 'VIRTUAL', numberMasked: view.numberMasked },
    });
    // 分组书写（空格 / 短横）归一化后同样精确命中，仍只回脱敏值。
    const spaced = `${numberFull.slice(0, 4)} ${numberFull.slice(4, 8)} ${numberFull.slice(8, 12)} ${numberFull.slice(12)}`;
    const dashed = `${numberFull.slice(0, 4)}-${numberFull.slice(4, 8)}-${numberFull.slice(8, 12)}-${numberFull.slice(12)}`;
    expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: spaced })).toMatchObject({ status: 'resolved', card: { id: view.id } });
    expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: dashed })).toMatchObject({ status: 'resolved', card: { id: view.id } });

    // 同一 `6222` 前缀、但中间 `0000` 段换成别的数字 ⇒ 不是任何一张卡的完整号。
    const altered = `${numberFull.slice(0, 4)}11110000${numberFull.slice(-4)}`;
    expect(altered).toHaveLength(16);
    expect(altered).not.toBe(numberFull);
    expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: altered })).toMatchObject({
      status: 'not_found',
      supplied: altered,
    });
  });

  it('补办换卡：新卡同样写入虚构完整号，且可被完整号选中', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID, { reason: '卡片丢失' });
    const replacement = await banking.card.replaceCard(DEBIT, DEMO_USER_ID);

    expect(replacement.id).not.toBe(DEBIT);
    expect(replacement.type).toBe('DEBIT');
    const numberFull = await expectFictionalIdentity(replacement);
    expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: numberFull })).toMatchObject({
      status: 'resolved',
      card: { id: replacement.id },
    });
  });

  it('demo 加卡：DEBIT / CREDIT 两条建卡分支都写入虚构完整号', async () => {
    const debit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });
    const debitFull = await expectFictionalIdentity(debit);

    const credit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'CREDIT', creditLimit: '2000.00' });
    const creditFull = await expectFictionalIdentity(credit);

    expect(debitFull).not.toBe(creditFull);
    for (const [view, numberFull] of [[debit, debitFull], [credit, creditFull]] as const) {
      expect(await resolveCardTarget(DEMO_USER_ID, { cardNumber: numberFull })).toMatchObject({
        status: 'resolved',
        card: { id: view.id },
      });
    }
  });

  it('连续新建两张卡：尾四位与完整号互不相同，cardTail 各自唯一解析', async () => {
    const first = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID });
    const second = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID });
    const firstFull = await expectFictionalIdentity(first);
    const secondFull = await expectFictionalIdentity(second);

    expect(firstFull).not.toBe(secondFull);
    expect(first.numberMasked.slice(-4)).not.toBe(second.numberMasked.slice(-4));

    expect(await resolveCardTarget(DEMO_USER_ID, { cardTail: first.numberMasked.slice(-4) })).toMatchObject({
      status: 'resolved',
      card: { id: first.id },
    });
    expect(await resolveCardTarget(DEMO_USER_ID, { cardTail: second.numberMasked.slice(-4) })).toMatchObject({
      status: 'resolved',
      card: { id: second.id },
    });
  });

  it('尾号唯一性契约：与既有卡（含只在 numberFull 里的尾号）相撞时改用下一个', async () => {
    // 一张"历史"卡片：展示值尾号 2500，服务端完整号尾号 0625 —— 两个尾号都不能被新卡复用。
    await db().card.create({
      data: {
        id: 'card_legacy_tail_only',
        userId: DEMO_USER_ID,
        type: 'VIRTUAL',
        network: 'UnionPay',
        numberMasked: '****2500',
        numberFull: '6222000000000625',
        status: 'ACTIVE',
        linkedAccountId: CHECKING_ACCOUNT_ID,
      },
    });

    const random = vi.spyOn(Math, 'random');
    try {
      // 2500 已被历史卡的展示值占用；0625 只出现在它的完整号里；1250 空闲。
      // （取值都是二进制精确的 2 的负幂，`Math.floor(x * 10000)` 才不会被浮点误差偏移。）
      random.mockReturnValueOnce(0.25).mockReturnValueOnce(0.0625).mockReturnValue(0.125);
      const view = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID });
      expect(view.numberMasked).toBe('****1250');
      expect(await readFullNumber(view.id)).toBe('6222000000001250');
    } finally {
      random.mockRestore();
    }

    // 既有卡片的尾号选择器不受影响：6688 仍是那张信用卡。
    expect(await resolveCardTarget(DEMO_USER_ID, { cardTail: '6688' })).toMatchObject({
      status: 'resolved',
      card: { id: CREDIT },
    });
    // 历史卡片（展示值 2500 / 完整号尾号 0625）也依旧各自唯一解析。
    expect(await resolveCardTarget(DEMO_USER_ID, { cardTail: '2500' })).toMatchObject({
      status: 'resolved',
      card: { id: 'card_legacy_tail_only' },
    });
    expect(await resolveCardTarget(DEMO_USER_ID, { cardTail: '0625' })).toMatchObject({
      status: 'resolved',
      card: { id: 'card_legacy_tail_only' },
    });
  });
});

describe('banking-sdk · 完整卡号永不外泄', () => {
  it('CardView 投影只有脱敏值：三条建卡路径的 JSON 都不含完整卡号', async () => {
    const virtual = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID });
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(DEBIT, DEMO_USER_ID);
    const demo = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });
    const listed = await banking.card.getCards(DEMO_USER_ID);

    // 列表投影覆盖到三张新卡（虚拟卡 / 补办卡 / demo 卡），所有投影都只带脱敏值。
    expect(listed.map(view => view.id)).toEqual(expect.arrayContaining([virtual.id, replacement.id, demo.id]));
    for (const view of [virtual, replacement, demo, ...listed]) {
      const numberFull = await readFullNumber(view.id); // 库里确实有完整号……
      const json = JSON.stringify(view);
      expect(json).not.toContain(numberFull); // ……但投影里没有
      expect(Object.keys(view)).not.toContain('numberFull');
      expect(Object.keys(view)).not.toContain('number');
      expect(view.numberMasked).toBe(maskCardNumber(numberFull.slice(-8)));
      expectNoCompleteNumber(json, [view.id, view.linkedAccountId, view.replacedByCardId]);
    }
  });

  it('建卡工具结果的 summary / data 只带脱敏值', async () => {
    const applied = await runApplyVirtualCard(DEMO_USER_ID, { monthlyLimit: '500.00' });
    expect(applied.ok).toBe(true);
    const virtual = applied.data as CardView;
    const virtualFull = await expectFictionalIdentity(virtual);
    expect(applied.summary).toContain(virtual.numberMasked);
    expect(applied.summary ?? '').not.toContain(virtualFull);
    expectNoCompleteNumber(applied.summary ?? '');
    expectNoCompleteNumber(JSON.stringify(applied.data), [virtual.id, virtual.linkedAccountId]);

    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);
    const replaced = await runReplaceCard(DEMO_USER_ID, { cardId: DEBIT });
    expect(replaced.ok).toBe(true);
    const replacement = replaced.data as CardView;
    const replacementFull = await expectFictionalIdentity(replacement);
    expect(replaced.summary).toContain(replacement.numberMasked);
    expect(replaced.summary ?? '').not.toContain(replacementFull);
    expectNoCompleteNumber(replaced.summary ?? '');
    expectNoCompleteNumber(JSON.stringify(replaced.data), [replacement.id, replacement.linkedAccountId, replacement.replacedByCardId]);
  });

  it('demo 加卡的审计与动作文本只带脱敏值', async () => {
    const session = await getDemoSession(DEMO_USER_ID);
    const identity = { userId: session.userId, sessionId: session.sessionId };
    const proposal = await proposeCardChange(identity, {
      requestId: randomUUID(),
      type: 'VIRTUAL',
      monthlyLimit: '300.00',
      linkedAccountId: CHECKING_ACCOUNT_ID,
    });
    const executed = await verifyCardChange(identity, proposal.change.id, MFA_CODE);
    expect(executed.ok).toBe(true);
    const card = executed.change.card as CardView;
    const numberFull = await expectFictionalIdentity(card);

    const action = await db().pendingAction.findUniqueOrThrow({ where: { id: proposal.change.id } });
    const audits = await db().auditLog.findMany({ where: { toolName: 'manual_add_card' } });
    expect(audits.length).toBeGreaterThan(0);

    const opaqueIds = [card.id, card.linkedAccountId, action.id, action.sessionId, action.userId,
      ...audits.flatMap(audit => [audit.id, audit.sessionId, audit.userId])];
    const texts = [action.argsJson, action.summaryJson ?? '', action.resultJson ?? '',
      ...audits.flatMap(audit => [audit.toolArgs ?? '', audit.toolResult ?? '', audit.detail ?? ''])];
    for (const text of texts) {
      expect(text).not.toContain(numberFull);
      expectNoCompleteNumber(text, opaqueIds);
    }
    // 审计仍是完整的成功记录（修复没有削弱既有的审计契约）。
    expect(audits.some(audit => audit.status === 'success')).toBe(true);
  });
});
