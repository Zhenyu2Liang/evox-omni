/**
 * Pure matcher for a FABRICATED confirmation-panel claim (`tests/e2e/panel-claim.e2e-helper.ts`).
 *
 * The LIVE browser acceptance entry FAILS a reply that asserts a confirmation/MFA panel ALREADY exists
 * while the model called NO controlled tool (no `PendingAction`, no card). This matcher decides
 * "does the prose CLAIM a panel?" and must stay precise:
 *   - POSITIVE: panel-existence phrasing tripping the guard.
 *   - NEGATIVE: an ordinary clarifying question and a TRUTHFUL "no panel appeared" nudge must NOT trip
 *     it, or the driver would misfire.
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