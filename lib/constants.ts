import type { RiskLevel } from './contracts/risk';

/** Daily transfer threshold above which a transfer escalates to RED. */
export const DAILY_TRANSFER_LIMIT = 1000;

/** Mock MFA code accepted by the demo verification flow. */
export const MFA_CODE = '123456';

/** Consecutive MFA failures before the circuit breaker trips for the session. */
export const MFA_MAX_ATTEMPTS = 3;

/** Transaction amount above which `detect_anomaly` flags a suspicious spend. */
export const ANOMALY_AMOUNT_THRESHOLD = 5000;

/** Seeded demo user id (李明). */
export const DEFAULT_DEMO_USER_ID = 'user_liming';

/** Cookie name holding the demo agent session id. */
export const SESSION_COOKIE = 'banking_session';

/** Human-readable (and emoji) label for each permission tier. */
export const RISK_LABEL: Record<RiskLevel, string> = {
  GREEN: '🟢 绿色',
  YELLOW: '🟡 黄色',
  RED: '🔴 红色',
};
