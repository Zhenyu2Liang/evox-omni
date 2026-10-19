/**
 * Pure matcher for a FABRICATED confirmation-panel claim (`tests/e2e/panel-claim.e2e-helper.ts`).
 *
 * The LIVE browser acceptance entry FAILS a reply that asserts a confirmation/MFA panel ALREADY exists
 * while the model called NO controlled tool (no `PendingAction`, no card). This matcher decides
 * "does the prose CLAIM a panel?" and must stay precise:
 *   - POSITIVE: panel-existence phrasing tripping the guard, including a claim that follows a truthful
 *     denial in an earlier clause of the same sentence.
 *   - NEGATIVE: an ordinary clarifying question and a TRUTHFUL "no panel appeared" nudge must NOT trip
 *     it, or the driver would misfire. Negation is clause-scoped: a cue ANYWHERE in the mentioned
 *     phrase's clause denies the panel (`、` does not end a clause), and an "appear"-verb negation
 *     directly after the mention (「确认面板尚未出现」) denies it too.
 *
 * DB-free and browser-free: importing the helper must not boot the Playwright harness.
 */
import { describe, expect, it } from 'vitest';

import {
  findConfirmationPanelClaim,
  hasConfirmationPanelClaim,
} from '../e2e/panel-claim.e2e-helper';

describe('findConfirmationPanelClaim — fabricated confirmation-panel claim matcher', () => {
  const claims: readonly string[] = [
    '请在上方的确认面板确认',
    '界面上方已出现确认面板，请确认',
    '请在上方面板中点击确认',
    '等待你的确认',
    '请在面板上完成确认',
    '已在面板确认',
    '您的转账请求已在确认面板等待处理',
    '已在验证面板',
    '等待你在面板里验证',
    '如果没有问题，请在上方的确认面板确认',
    '界面上方没有出现卡片的话，请在上方的确认面板确认',
    '系统已经为你打开了核对面板',
    '确认面板已弹出',
    '本次补办为红色高风险操作，需要你在上方确认',
    '我已提交补办，随后你在面板里完成了验证',
    // A truthful denial in an EARLIER clause must not swallow the claim in the later clause.
    '界面上方没有出现卡片，现在确认面板已就绪',
    '没有出现卡片，请在上方面板中点击确认',
    '确认面板已弹出，无需再次确认',
    '上方面板已经打开, 请确认转账',
    '界面上方已出现确认面板; 请完成验证',
    '等待你在面板中确认，然后回复我',
    '等待你的确认，界面已刷新',
  ];

  const nonClaims: readonly string[] = [
    '请确认是否向张伟转账 ¥200.00？',
    '请确认是否继续？',
    '这笔转账金额较大，是否确认？',
    '界面上方没有出现确认面板，请重新发起这张卡的挂失',
    '界面上方没有出现确认面板，请重新发起补办',
    '界面上方尚未出现确认面板',
    '未出现确认面板',
    '已为你办理，无需确认',
    '请直接帮我办理挂失，我已经确认',
    '确认，请办理',
    '请直接为我补办一张新卡，我已确认',
    // LIVE scenario lG round 5: the model truthfully denied a panel and the guard misfired on 验证面板.
    '刚才那笔补办业务已经执行完成了，没有遗留的待确认或待验证环节，因此现在既没有正在等待的操作，也不会出现验证面板。',
    // LIVE scenario lG round 6: 「、」 coordinates phrases inside ONE clause, so 不存在 still governs
    // 等待您确认 — the guard misfired on it while the negation window stopped short of the cue.
    '不存在尚未发起、或仍在等待您确认的步骤',
    '不存在尚未发起、或仍在等待您验证的步骤',
    // Negated / unrealised formulations assert the OPPOSITE of a panel and must never match, wherever the
    // cue sits in the clause (before the mention, after it, or in the preceding clause).
    '系统不会出现验证面板',
    '系统不会显示确认面板',
    '当前不会弹出确认面板',
    '不会创建授权面板',
    '现在没有确认面板',
    '不存在核对面板',
    '暂无授权面板',
    '系统不会为你创建任何确认面板',
    '当前没有正在等待你的确认',
    '确认面板尚未出现',
    '确认面板未显示',
    '界面上方并没有出现确认面板',
    '我没有看到确认面板',
    '界面上方没有出现确认',
    '上方的确认面板不会出现了',
    '这次不需要确认面板',
    '没有任何正在等待你的确认',
    '已确认，界面上方没有出现确认面板',
    '我没有看到界面上方的面板',
    '界面上方没有出现确认面板, 请重新发起补办',
    '界面上方没有出现确认面板! 请稍后再试。',
    '不会出现验证面板; 现在系统状态正常',
    '系统不会创建授权面板。请稍后再试。',
  ];

  it.each(claims)('detects a panel-existence claim: %s', (prose) => {
    expect(findConfirmationPanelClaim(prose)).toBeDefined();
    expect(hasConfirmationPanelClaim(prose)).toBe(true);
  });

  it.each(nonClaims)('does NOT misfire on a non-claim: %s', (prose) => {
    expect(findConfirmationPanelClaim(prose)).toBeUndefined();
    expect(hasConfirmationPanelClaim(prose)).toBe(false);
  });

  it('returns the matched panel phrase for the caller error message', () => {
    expect(findConfirmationPanelClaim('界面上方已出现确认面板，请确认')).toContain('确认面板');
  });

  it('ignores empty prose', () => {
    expect(findConfirmationPanelClaim('')).toBeUndefined();
    expect(hasConfirmationPanelClaim('   ')).toBe(false);
  });
});
