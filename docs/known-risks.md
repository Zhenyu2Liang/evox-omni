# Current limits

Earlier repair/live reports describe their recorded versions. This list describes the current implementation.

| Area | Current behavior | Remaining limit |
| --- | --- | --- |
| Money | Booked bigint cents, Decimal ratios and estimates, string-only financial boundaries | CNY settlement scale; signed INT64 booked values; 40 integer / 18 fractional Decimal digits |
| Permission | Code-enforced tiers and cumulative in-flight risk | Demo cookie identity; no production user/staff authentication |
| Verification | Expiry, operation binding, attempts and consumption | Fixed demo factor; no SMS or facial provider |
| Commands | Mutation, required audit and receipt in one local transaction | Real adapters must prove equivalent idempotency |
| Runtime | Observed Pi events, model input/result checkpoints and bounded process recovery | Unfinished generation is regenerated; exact partial token output is not resumed |
| Retry | Stored/current policy, bounded attempts, receipt-first recovery | Unknown external effects require reconciliation |
| Workflow | Atomic graph, typed conditions, journaled child calls and ownership fences | Paused graphs, unknown effects and original authorizations require explicit action |
| Scheduler | Persistent dispatch claim, delivered reminders, freshly gated due transfers | Worker availability controls execution timing |
| Birthday | Budget envelope and simulated scheduled intents | Envelopes do not hold withdrawable funds; actual procurement is absent |
| Investment | Product comparison, holding purchase and full redemption | No suitability questionnaire or complete annual report |
| Journal | Credential redaction and public/private event channels | No encryption at rest, retention policy or independent staff RBAC |
| Storage | Current SQLite schema and writer serialization | Older schemas are unsupported; multi-host failover and other database engines need validation |

The recovery worker must be started separately with `pnpm agent:worker` or invoked as a bounded pass with `pnpm agent:recover`. It does not start implicitly with the web server. Model requests retain their original provider, endpoint, input and tool definitions; changed contracts or newer session revisions stop continuation. Persisted attempt limits and backoff prevent unbounded automatic retries. Unknown effects park for reconciliation instead of repeated discovery. See [agent durability](agent-durability.md).

Security and lease clocks use real elapsed time. Business analysis uses an explicit UTC+08:00 demo date. The scheduler CLI can accept a trusted test clock; public callers cannot set it.

Current receipt corruption or a committed ledger with missing evidence requires reconciliation; no historical format reconstruction is attempted. `db:reset` recreates the simulated dataset.
