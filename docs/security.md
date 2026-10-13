# Security design and self-assessment

Authorization comes from server policy. Model text and confirmation-like user phrases cannot grant an execution right.

`lib/contracts/tool-catalog.ts` defines capabilities, effects, default tiers and replay requirements. Subscriptions query/cancellation require confirmation. Transfers always require confirmation and escalate to RED when the amount plus booked and in-flight daily transfers exceeds `1000.00` CNY. Investment operations, card loss/unlock and simulated credential changes require verification.

Authorization records retain owner, command digest, policy version, reasons and deterministic risk inputs. Secrets are redacted from arguments. Pending actions link the authorization and invocation. Decision records and committed execution audits are separate facts.

The authenticator is explicitly a demo adapter using `123456`; no SMS is sent. Challenges have real five-minute expiry, operation binding, attempt limits and a consumed timestamp. Valid reissue preserves attempts. Expired, consumed or changed-command challenges are rejected. Unsupported authentication modes fail rather than silently falling back to the demo factor.

All registered writes use one transaction for mutation, strict audit, original response receipt and invocation completion. Receipts check owner, tool and digest. Transfer projections also match their actual ledger. Workflow tokens, generations, confirmation claims, session locks and runtime leases are checked at the mutation boundary. A stale owner cannot commit new work. Already-committed work retains its result after later cancellation or handoff.

The model has no shell, filesystem, SQL, arbitrary HTTP or code execution tools. Schemas and the plan compiler restrict executable capabilities. Three distinct suspicious instruction signals within ten minutes lock the account. Repeated business failures have their own window. Signal identity prevents duplicate delivery from inflating counts; incident, resulting lock and trip audit commit together.

Financial statements are server-authored from structured results. Planning prose cannot prove execution. Unknown outcomes retain reconciliation status. Every observed Pi event is retained internally after credential redaction; thinking is internal. Public APIs expose grounded UI events and safe execution metadata. Audit endpoints and summaries require owned session identity.

Run recovery keeps the original invocation and operation key. It restores verified receipts and retries eligible GREEN reads. Gated queries need their original approval. Writes, unknown tools and workflow submissions are not replayed blindly. A journal failure before tool start prevents the effect.

The application uses demo cookie identity and local SQLite. Production login, operator RBAC, real bank/payment rails and a real second-factor provider are absent. The tool capability restriction is the model sandbox; arbitrary generated code is not executed. Raw journal encryption, retention and privileged access need production design. Distributed database and external service idempotency require independent validation. See [known limits](known-risks.md).
