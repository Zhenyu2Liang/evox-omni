import type { RiskLevel } from './contracts/risk';

/** Daily transfer threshold above which a transfer escalates to RED. */
export const DAILY_TRANSFER_LIMIT = '1000.00';

/** Mock MFA code accepted by the demo verification flow. */
export const MFA_CODE = '123456';

/** Consecutive MFA failures before the circuit breaker trips for the session. */
export const MFA_MAX_ATTEMPTS = 3;

/**
 * Cooldown (ms) after a circuit-breaker trip during which unlocking REQUIRES the mock
 * verification code. Once this window elapses since `lockedAt`, the lock may be cleared
 * without a code (the explicit cooldown condition). See `security/circuit-breaker.ts`.
 */
export const RESET_COOLDOWN_MS = 60_000;

/** Transaction amount above which `detect_anomaly` flags a suspicious spend. */
export const ANOMALY_AMOUNT_THRESHOLD = '5000.00';

/** Seeded demo user id (李明). */
export const DEFAULT_DEMO_USER_ID = 'user_liming';

/**
 * Fixed "as-of" instant for the demo (2026-09-25 12:00 LOCAL), so 本月/上月/今日, the spending
 * window, the daily-transfer window and the seeded data (incl. the 2026-09-20 18:32 anomaly)
 * stay coherent regardless of the real system clock. Built from LOCAL components so it agrees
 * with date formatting and the test fixtures on any container timezone.
 *
 * ALL relative-date logic in the running app MUST default to this clock (overridable by an
 * explicit `now` argument so tests stay deterministic). See `lib/clock.ts` (`demoNow()`).
 */
export const DEMO_NOW = Date.parse('2026-09-25T12:00:00+08:00');

/** Human-readable (and emoji) label for each permission tier. */
export const RISK_LABEL: Record<RiskLevel, string> = {
  GREEN: '🟢 绿色',
  YELLOW: '🟡 黄色',
  RED: '🔴 红色',
};
