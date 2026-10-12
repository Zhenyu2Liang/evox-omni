# integration — Maintained cross-module regressions

`request-scope-holdings.test.ts` retains the two failing 110e20a probes and validates qualifier scope, complete-plan repair, real confirmation/MFA, owned current-holding binding, ambiguity/foreign/inactive refusals before automatic writes and distinct same-product holding IDs. Controlled transport is not genuine DeepSeek evidence.

`live-complete-plan.test.ts` rejects standalone first writes and incomplete DAGs before any authorization or automatic budget. A bounded repair creates one complete plan; confirmations resume its persisted nodes with no model narration or duplicate debits. Transport is controlled, not genuine DeepSeek.

live-recovery.test.ts drives real Pi/gateway/SQLite through bounded planning failures, no-effect
recovery, committed budget preservation and real transfer confirmation without a narration request.
live-retry-ui.test.ts covers latest-reply button visibility and refresh input (server rendering only).

`request-step-binding.test.ts` exercises actual task execution and confirmation/MFA routes: success-only prerequisites, failed-transfer descendant suppression, per-purchase product/cent binding, independent MFA decisions and replay, and whole-plan rejection of substituted/extra/missing purchases before automatic writes.

`decision-guidance.test.ts` covers route/ledger MFA escalation across multiple decisions, full
streamed summaries and legacy refresh, plus strict guidance validation and Pi/SSE/session output.

`frontend-followup-fixes.test.ts` covers explicit virtual-card limits and replay, full redemption quote/transaction consistency and name/code ambiguity, plus owner-scoped MFA challenge renewal with strict unlock-audit rollback. It uses production gateways/SDK and isolated test SQLite; live browser evidence is documented in `docs/frontend-followup-report.md`.

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
| message-protocol.test.ts | Persisted pi transcript validity: every toolResult answers a preceding toolCall (no orphan/duplicate/fabricated id) |
| terminal-state-settle.test.ts | Confirm/cancel on terminal actions (stable 200 domain outcome, no rollback/double-charge) |
| grounding-regression.test.ts | Real runTurn/resumeTurn pipeline: code-enforced financial-fact grounding replaces an ungrounded/contradictory narration (no false success; streamed == terminal == persisted); plus PURE-level coverage of missed facts (cross-clause/unmarked amount, tool-call-bearing message), post-write-vs-stale per-account balance authority, and same-tool-twice per-operation claim mapping (incl. unknown → 待核对) |

Run npm run test -- tests/integration. Observe ../CONTEXT.md database isolation and no-weakening rules.
These are in-process integration tests, not browser E2E.

## Scope notes

Most suites here assert on MODEL-independent data. Assertions observe PERSISTED DB state (balances,
row/node/plan statuses, counts, audits, receipts) and SERVER-side route/outcome strings
(ConfirmationOutcome.message, API data.message, node.error/node.output).
Two suites are model-adjacent, both driving the deterministic mock/scripted model through real
facades: message-protocol.test.ts asserts transcript STRUCTURE (toolCall/toolResult pairing), not prose;
and grounding-regression.test.ts drives the real runTurn/resumeTurn pipeline with a scripted provider
to pin the code-enforced financial-fact grounding — an ungrounded or contradictory narration is
replaced by the server-owned result narrative, asserted through public stream events + loadSession
(grounding itself is never re-implemented). Other hallucination-guard checks (success-vs-failure
wording, invented balance) live OUTSIDE this node — see tests/scenarios/ (test-05-failure-report,
test-02-transfer-confirm, mock-integration) and tests/unit/agent/.


inancial-response-boundary.test.ts drives real Pi, SSE and persistence with adversarial narration, including tool-call preludes, decimal SDK debit, UNKNOWN and DAG continuation attribution. No model-authored financial prose enters the UI or subsequent Pi prose history.
