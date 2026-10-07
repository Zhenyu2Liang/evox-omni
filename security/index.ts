/**
 * Security node — public facade.
 *
 * Re-exports the security sub-modules as namespaces and aggregates them into a
 * single `security` object. Consumers (the agent layer, API routes, tests) import from
 * here rather than reaching into individual files where possible.
 *
 * The security model is code-enforced and LLM-immutable: nothing in this node consults
 * model output to decide a tier, confirmation, or MFA requirement.
 */
import * as permission from './permission-engine';
import * as risk from './risk-engine';
import * as mfa from './mfa';
import * as circuitBreaker from './circuit-breaker';
import * as injection from './injection-guard';
import * as gateway from './security-gateway';
import * as recovery from './recovery-authorization';

export { permission, risk, mfa, circuitBreaker, injection, gateway, recovery };

/** Aggregate facade: `security.gateway.evaluate(...)`, `security.injection.scan(...)`, etc. */
export const security = { gateway, permission, risk, mfa, circuitBreaker, injection, recovery };
