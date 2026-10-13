# Security context

This layer decides permission, confirmation, verification, risk and lock state in code. It does not execute banking business operations.

`lib/contracts/tool-catalog.ts` is the shared source of names, effects, default tiers and replay requirements. `permission-engine.ts` derives static policy. `risk-engine.ts` uses exact bigint arithmetic and decimal string outputs. Transfers always need a human decision; cumulative booked plus unposted in-flight amounts above `1000.00` require verification. Subscription queries are YELLOW.

`security-gateway.ts` validates owned resources, records deterministic authorization decisions and creates pending actions. It claims confirmation atomically and reevaluates cumulative risk. Open manual review blocks new execution claims; existing authorized in-flight commands may settle. `authorization-record.ts` records policy version, command fingerprint, reasons and redacted inputs.

`mfa.ts` binds a five-minute wall-clock challenge to the command, preserves valid challenge attempts and records consumption. `step-up-authenticator.ts` is explicitly a demo adapter with no SMS delivery. Unsupported modes fail. A real provider and authenticated staff/user identity are separate production work.

`injection-guard.ts` detects suspicious instructions. `incidents.ts` persists deduplicated signals, related security events and account-wide locks in one transaction. `circuit-breaker.ts` applies verification failure locks and audited cooldown reset. Locks are shared by the user's sessions.

`execution-policy.ts` checks write policy on the actual transaction client. `recovery-authorization.ts` grants only currently permitted new recovery effects; verified receipts bypass new mutation and remain recoverable during a lock. Unknown outcomes are not failures and must not be retried blindly.

Model tools exclude arbitrary code, SQL, shell, files and external HTTP. Public journal readers exclude raw thinking and credentials. Financial claims are rendered by the agent from SDK and receipt facts. See `docs/security.md` and `docs/known-risks.md`.
