# integration — Maintained cross-module regressions

Real DB/route/gateway/executor tests; only model responses and execution scheduling are controlled.
File names describe the invariant. Existing assertions are retained; historical duplicate probes
remain recoverable from Git.

| Suite | Coverage |
| --- | --- |
| money-budget.test.ts | Exact cents, concurrent limits, budget ownership and automatic-write fences |
| confirmation-policy.test.ts | Write-time breaker checks, MFA metadata, terminal UI and strict audits |
| recovery-authorization.test.ts | Recovery escalation, locked recovery, resource ownership and reconciliation audit |
| sdk-transaction-fences.test.ts | SDK fences, legacy history, verified receipts and strict audit dedupe |
| financial-node-concurrency.test.ts | In-flight totals, investment replay and cancellation before authorization |
| execution-audit.test.ts | Critical audit rollback, historical backfill and idempotency |
| committed-outcomes.test.ts | Committed plan/standalone outcomes and unknown writes |
| confirmation-liveness.test.ts | Concurrent verification and continuation liveness |
| confirmation-continuation.test.ts | Initial takeover, duplicate confirmation and standalone result gaps |
| action-refresh.test.ts | Processing/recoverable actions after refresh and restart |
| execution-barriers.test.ts | Pre-tool, notification and pre-write takeover barriers |
| executor-leases.test.ts | One stale-claim winner and active-owner renewal |
| execution-integrity.test.ts | Fenced results/status and completed successor protection |
| initial-executor-fencing.test.ts | No stale progress from an initial executor that lost its claim |
| obsolete-executor.test.ts | Superseded executor stops without overwriting work |
| takeover-controls.test.ts | Takeover combined with cancel, pause and human decisions |
| write-idempotency.test.ts | Posted truth, virtual-card replay and redemption identity |
| transfer-replay.test.ts | Same-request replay, request conflicts and original snapshots |
| transfer-receipts.test.ts | Receipt rollback, identity and concurrent recovery |
| transfer-history.test.ts | Recovery after contact changes/deletion and plan cancellation |
| confirmation-evidence.test.ts | Post-commit exceptions, legacy ledger recovery, cancellation and audit rollback |
| node-recovery.test.ts | Executed-node restoration, stale owners and redemption concurrency |
| node-result-recovery.test.ts | Stored results, repeated/concurrent recovery and unknown side effects |
| standalone-recovery.test.ts | Standalone wedges, safe replay and visible unknown outcomes |
| restart-recovery.test.ts | Persisted evidence after module/registry reset |

Run npm run test -- tests/integration. Observe ../CONTEXT.md database isolation and no-weakening rules.
These are in-process integration tests, not browser E2E.
