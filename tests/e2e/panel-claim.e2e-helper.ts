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
 * Every claim pattern as a stateful (global) copy, so EVERY occurrence inside a sentence is inspected
 * instead of only the first one of each pattern.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [...PANEL_CLAIM_PATTERNS, ...WAITING_CLAIM_PATTERNS].map(
  (pattern) => new RegExp(pattern.source, 'g'),
);

/**
 * Negation cues that turn a panel MENTION into a (truthful) statement that NO panel exists.
 *
 * CONTRACT: this matcher recognises ONLY wording that ASSERTS a confirmation/MFA panel already exists.
 * Every negated formulation asserts the OPPOSITE and must NEVER match — e.g.
 * 「界面上方没有出现确认面板」/「不会出现验证面板」/「不会显示确认面板」/「不会弹出确认面板」/
 * 「不会创建授权面板」/「没有确认面板」/「不存在核对面板」/「暂无授权面板」 — otherwise a truthful
 * narration would be failed as a fabrication. 「不」 covers 不会/不应/不能/不可/不再, 「没」 covers 没有,
 * 「未」 covers 尚未/从未; the full forms are listed anyway to mirror the wording the model produces.
 */
const NEGATION_CUE =
  /不|不会|不应|不能|不可|不再|没有|没|尚未|未|从未|无法|无|不存在|不存|暂无|并无|并未|并不|并不是/;

/**
 * Clause separators. Negation is scoped to ONE clause: 「，」/`,` and the ASCII sentence punctuation
 * 「!」「?」「;」 plus 「。」「！」「？」「；」 and line breaks end a clause.
 *
 * 「、」 is deliberately NOT a separator: it enumerates COORDINATED phrases inside one clause, so
 * 「不存在 A、或仍在等待您确认的 B」 keeps the negation in scope for B.
 */
const CLAUSE_SEPARATOR = /[，,。！？；!?;\n\r]/;

/**
 * 「确认面板尚未出现」/「确认面板未显示」/「确认面板不会出现」 — an "appear"-verb negation sitting
 * immediately after the mention equally denies that the panel exists.
 */
const APPEAR_NEGATION_AFTER =
  /^\s*(?:不会|并没有|没有|不存在|暂无|尚未|未|并无)(?:出现|显示|弹出|创建|生成|渲染|展示|打开)/;

/** Split prose into sentence-ish segments (the split chars are dropped). */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n\r；;]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Index of the LAST clause separator inside `text`, or -1. */
function lastSeparatorIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (CLAUSE_SEPARATOR.test(text[index])) return index;
  }
  return -1;
}

/** Index of the FIRST clause separator inside `text`, or -1. */
function firstSeparatorIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (CLAUSE_SEPARATOR.test(text[index])) return index;
  }
  return -1;
}

/**
 * The clause holding the match: from the separator before the matched phrase up to the separator after
 * it, so the matched text itself and everything before/after it in the SAME clause are all in view.
 */
function clauseAround(sentence: string, matchIndex: number, matchLength: number): string {
  const matchEnd = matchIndex + matchLength;
  const clauseStart = lastSeparatorIndex(sentence.slice(0, matchIndex)) + 1;
  const afterSeparator = firstSeparatorIndex(sentence.slice(matchEnd));
  const clauseEnd = afterSeparator === -1 ? sentence.length : matchEnd + afterSeparator;
  return sentence.slice(clauseStart, clauseEnd);
}

/**
 * Is the match wrapped in a negation? A negation cue ANYWHERE in the match's own clause — before the
 * phrase, inside the phrase (a position-style match such as 「界面上方没有出现确认」 swallows the cue),
 * or after it — denies the panel, however far from the phrase the cue sits. An "appear"-verb negation
 * immediately after the phrase (「确认面板尚未出现」) denies it as well.
 */
function isNegatedClaim(sentence: string, matchIndex: number, matchText: string): boolean {
  if (NEGATION_CUE.test(clauseAround(sentence, matchIndex, matchText.length))) return true;
  return APPEAR_NEGATION_AFTER.test(sentence.slice(matchIndex + matchText.length));
}

/**
 * Return the matched claim phrase when `prose` ASSERTS a confirmation/MFA panel already exists (or that
 * the model is waiting on such a confirmation), else `undefined`. A negated mention
 * ("界面上方没有出现确认面板" / "不会出现验证面板" / "确认面板尚未出现") is NOT a claim.
 */
export function findConfirmationPanelClaim(prose: string): string | undefined {
  for (const sentence of splitSentences(prose)) {
    for (const pattern of CLAIM_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(sentence);
      while (match !== null) {
        if (!isNegatedClaim(sentence, match.index, match[0])) return match[0];
        if (match[0].length === 0) pattern.lastIndex += 1;
        match = pattern.exec(sentence);
      }
    }
  }
  return undefined;
}

/** Convenience predicate: does `prose` assert a confirmation/MFA panel already exists? */
export function hasConfirmationPanelClaim(prose: string): boolean {
  return findConfirmationPanelClaim(prose) !== undefined;
}
