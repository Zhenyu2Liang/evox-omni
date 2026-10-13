# Documentation

These documents describe the current implementation. Start with the development guide to run or change the project, then use the architecture and topic guides to understand its contracts.

## Current guides

| Document | Read it when you need to understand |
| --- | --- |
| [Development](development.md) | Local setup, model configuration, database lifecycle, tests and contribution workflow |
| [Architecture](architecture.md) | Runtime boundaries, tool execution, workflow ownership and persistence |
| [Agent durability](agent-durability.md) | Pi event journal, invocation identity, safe retries, recovery and Pi Durable tradeoffs |
| [Financial values](financial-values.md) | Monetary units, Decimal precision, BigInt booking and investment settlement |
| [Money and budget boundaries](money-budget-boundaries.md) | Write fences, idempotency and the meaning of a budget envelope |
| [Security](security.md) | Permission tiers, confirmation, MFA, audit and incident controls |
| [Manual review](manual-review.md) | Operator handoff, evidence and safe workflow continuation |
| [Scheduled tasks](scheduled-tasks.md) | Due reminders, payment dispatch, worker operation and fresh authorization |
| [Test coverage](test-cases.md) | Scenario coverage, test layers and regression entry points |
| [Known limits](known-risks.md) | Implemented guarantees, simulated behavior and unverified deployment conditions |

The [competition requirements](../req.md) provide the evaluation context. They do not replace the implemented contracts described above.

## Source navigation

The architecture guide links to the implementation modules. Directory-level `CONTEXT.md` files provide local maintenance context; [the repository context](../CONTEXT.md) maps the main boundaries and invariants. Public types live in [`lib/contracts/`](../lib/contracts/), and the persisted model lives in [`prisma/schema.prisma`](../prisma/schema.prisma).

## Historical records

These reports document particular changes or verification runs. Their counts, limitations and implementation details apply to the versions they examined; use the current guides for development decisions.

| Record | Topic |
| --- | --- |
| [Pi upgrade](pi-upgrade.md) | Adoption of Pi 1.1 and provider runtime changes |
| [Confirmation repairs](repair-confirmation-boundaries.md) | Confirmation boundary repair round |
| [Recovery and security repairs](repair-recovery-security.md) | Recovery and security repair round |
| [Transaction repairs](repair-transaction-boundaries.md) | Transaction boundary repair round |
| [Frontend repairs](frontend-repair-report.md) | Frontend repair verification |
| [Frontend follow-up](frontend-followup-report.md) | Follow-up interface repairs |
| [Decision guidance](decision-guidance-report.md) | Decision and retry guidance verification |
| [Request scope and holdings](request-scope-holdings-report.md) | Request binding and holding selection verification |
| [Live recovery](live-recovery-report.md) | Live model recovery verification |
| [Live complete plans](live-complete-plan-report.md) | Live model multi-step planning verification |

## Documentation ownership

The root README owns the project overview, quick start, common commands and entry links. This directory owns architecture, development procedures and detailed behavioral contracts. Keep a rule in its topic guide and link to it from other documents. When code changes a contract, update the owning guide in the same change.
