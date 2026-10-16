/**
 * `tests/e2e/panel-claim.e2e-helper.ts` — pure matcher for a FABRICATED confirmation-panel claim.
 *
 * The LIVE model sometimes replies with ONLY prose asserting that a confirmation/MFA panel ALREADY
 * exists ("请在上方的确认面板确认" / "等待你的确认" / "已在面板确认") while it actually called NO
 * controlled tool — so the security gateway never parked a `PendingAction`, `GET /api/actions` stays
 * empty and no confirmation/MFA card renders. This module detects that claim from the assistant prose
 * alone (no DOM, no network) so `helpers.ts#assertNoFabricatedConfirmationPanel` can FAIL it explicitly.
 *
 * It has NO imports, so a plain unit test can import it without booting the browser harness.
 *
 * It deliberately does NOT match an ordinary clarifying question ("请确认是否向张伟转账 ¥200.00？"):
 * such a question claims NEITHER a panel NOR an existing gate and must keep following the existing
 * nudge logic.
 */

/** Phrases that assert a confirmation/MFA PANEL (a gate surface) is present. */
const PANEL_CLAIM_PATTERNS: readonly RegExp[] = [
  // 「确认面板」/「验证面板」/… — a named gate surface.
  /确认面板/,
  /验证面板/,
  /核对面板/,
  /授权面板/,
  // 「上方面板」/「界面…面板」 — a panel positioned above the transcript.
  /(上方|界面上方|页面上方|页面顶部|顶部|上侧)(的)?面板/,
  // 「在面板中/上/里…」 — a reference to acting inside a panel.
  /面板(中|上|里|内)/,
  // 「已在面板」/「已在确认面板」 — already-in-the-panel claim.
  /已在(确认|验证|授权)?面板/,
  // 「请在上方确认」/「界面上方…确认」 — a gate surface named by position.
  /(上方|界面上方|页面上方|页面顶部|顶部).{0,8}(确认|验证|授权)/,
];

/** Phrases that assert the model is BLOCKED waiting on the user's decision (implies a gate surface). */
const WAITING_CLAIM_PATTERNS: readonly RegExp[] = [
  /等待(你|您)(的)?(确认|验证|授权)/,
];

/**
 * Negations that turn a panel MENTION into a (truthful) statement that NO panel exists, e.g.
 * 「界面上方没有出现确认面板」. Checked in a window around the match so a negated mention never trips
 * the guard.
 */
const PANEL_NEGATIONS: readonly string[] = ['没有出现', '未出现', '不存在', '尚未出现', '尚未', '无法', '没有'];

/** Split prose into sentence-ish segments (the split chars are dropped). */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n\r；;]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Return the matched claim phrase when `prose` ASSERTS a confirmation/MFA panel already exists (or that
 * the model is waiting on such a confirmation), else `undefined`. A mention wrapped in a negation
 * ("没有出现确认面板") is NOT a claim.
 */
export function findConfirmationPanelClaim(prose: string): string | undefined {
  for (const sentence of splitSentences(prose)) {
    for (const pattern of [...PANEL_CLAIM_PATTERNS, ...WAITING_CLAIM_PATTERNS]) {
      const match = pattern.exec(sentence);
      if (match === null) continue;
      const window = sentence.slice(Math.max(0, match.index - 6), match.index + match[0].length);
      if (PANEL_NEGATIONS.some((negation) => window.includes(negation))) continue;
      return match[0];
    }
  }
  return undefined;
}

/** Convenience predicate: does `prose` assert a confirmation/MFA panel already exists? */
export function hasConfirmationPanelClaim(prose: string): boolean {
  return findConfirmationPanelClaim(prose) !== undefined;
}
