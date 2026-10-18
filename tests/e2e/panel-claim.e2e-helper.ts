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
 * Negation cues that turn a panel MENTION into a (truthful) statement that NO panel exists.
 *
 * CONTRACT: this matcher recognises ONLY wording that ASSERTS a confirmation/MFA panel already exists.
 * Every negated or unrealised formulation asserts the OPPOSITE and must NEVER match — e.g.
 * 「界面上方没有出现确认面板」/「不会出现验证面板」/「不会显示确认面板」/「不会弹出确认面板」/
 * 「不会创建授权面板」/「没有确认面板」/「不存在核对面板」/「暂无授权面板」 — otherwise a truthful
 * narration would be failed as a fabrication.
 */
const NEGATION_CUE = /不(?:会|应|该|能|可|再)|没有|没|尚未|未|从未|无法|无|不存在|暂无|并未|并不/;

/**
 * How far before the matched phrase a negation cue may sit. Together with the punctuation barrier this
 * keeps the true claims matching: an earlier, unrelated negation separated by 「，」
 * (「如果没有问题，请在上方的确认面板确认」) stays outside the window and cannot swallow the claim.
 */
const NEGATION_LOOKBEHIND = 10;

/** Punctuation always ends a negation window (a clause boundary ends the negation's scope). */
const CLAUSE_BOUNDARY = /[，,。；;！!？?：:、\n\r]/;

/** 「确认面板尚未出现」 — the negation follows the panel word; only real "appear" verbs count here. */
const NEGATION_AFTER_CLAIM = /^(不会|没有|不存在|暂无|尚未|未|并无)(出现|显示|弹出|创建|生成|渲染|展示)/;

/** Split prose into sentence-ish segments (the split chars are dropped). */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n\r；;]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Is the match at `matchIndex` wrapped in a negation/unrealised formulation? Three bounded windows: the
 * clause text just BEFORE the phrase (punctuation ends it), the phrase itself (a position-style match
 * such as 「界面上方没有出现确认」 swallows the negation), and an "appear"-verb
 * negation directly AFTER it (「确认面板尚未出现」).
 */
function isNegatedClaim(sentence: string, matchIndex: number, matchText: string): boolean {
  const lookbehind = sentence.slice(Math.max(0, matchIndex - NEGATION_LOOKBEHIND), matchIndex);
  const clause = lookbehind.split(CLAUSE_BOUNDARY).pop() ?? '';
  if (NEGATION_CUE.test(clause)) return true;
  if (NEGATION_CUE.test(matchText)) return true;
  return NEGATION_AFTER_CLAIM.test(sentence.slice(matchIndex + matchText.length));
}

/**
 * Return the matched claim phrase when `prose` ASSERTS a confirmation/MFA panel already exists (or that
 * the model is waiting on such a confirmation), else `undefined`. A negated mention
 * ("界面上方没有出现确认面板" / "不会出现验证面板") is NOT a claim.
 */
export function findConfirmationPanelClaim(prose: string): string | undefined {
  for (const sentence of splitSentences(prose)) {
    for (const pattern of [...PANEL_CLAIM_PATTERNS, ...WAITING_CLAIM_PATTERNS]) {
      const match = pattern.exec(sentence);
      if (match === null) continue;
      if (isNegatedClaim(sentence, match.index, match[0])) continue;
      return match[0];
    }
  }
  return undefined;
}

/** Convenience predicate: does `prose` assert a confirmation/MFA panel already exists? */
export function hasConfirmationPanelClaim(prose: string): boolean {
  return findConfirmationPanelClaim(prose) !== undefined;
}
