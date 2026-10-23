/**
 * A recovery outcome may only ever report the DECISION THE PERSISTED ROW CARRIES. The two failure
 * modes this pins down:
 *  - a caller's pre-authorization snapshot goes stale while a competing continuation upgrades the row
 *    to RED + MFA, so the settled outcome must not be downgraded to `YELLOW`/`requiresMfa:false`;
 *  - a row persisted as RED can never be reported as MFA-free, whatever its `requiresMfa` column says.
 */
import { describe, expect, it } from 'vitest';
import { persistedDecision } from './confirmation-recovery';

describe('persistedDecision', () => {
  it('reads a RED row as RED and MFA-required', () => {
    expect(persistedDecision({ riskLevel: 'RED', requiresMfa: true })).toEqual({ tier: 'RED', requiresMfa: true });
  });

  it('derives the MFA requirement from the RED tier even when the column lags behind', () => {
    expect(persistedDecision({ riskLevel: 'RED', requiresMfa: false })).toEqual({ tier: 'RED', requiresMfa: true });
  });

  it('reports an MFA-carrying lower tier as RED, never as YELLOW-with-MFA', () => {
    expect(persistedDecision({ riskLevel: 'YELLOW', requiresMfa: true })).toEqual({ tier: 'RED', requiresMfa: true });
  });

  it('keeps a confirm-only row at its persisted tier without inventing an MFA requirement', () => {
    expect(persistedDecision({ riskLevel: 'YELLOW', requiresMfa: false })).toEqual({ tier: 'YELLOW', requiresMfa: false });
    expect(persistedDecision({ riskLevel: 'GREEN', requiresMfa: false })).toEqual({ tier: 'GREEN', requiresMfa: false });
  });
});
