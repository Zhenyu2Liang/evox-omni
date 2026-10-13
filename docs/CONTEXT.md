# Documentation context

## Purpose

This directory owns the project's architecture and developer documentation. Describe the current implementation, its guarantees and its limits using the code and tests as evidence. The root README introduces the project and provides the shortest supported setup path; detailed design and operational instructions belong here.

## Routing

| Document | Scope |
| --- | --- |
| [README.md](README.md) | Documentation index and reading paths |
| [development.md](development.md) | Local development, configuration, commands and database lifecycle |
| [architecture.md](architecture.md) | Module boundaries, request execution, planning and persistence |
| [security.md](security.md) | Authorization, confirmation, MFA, execution fences, auditing and identity |
| [agent-durability.md](agent-durability.md) | Pi event journals, tool invocations, receipts, retry policy and restart recovery |
| [financial-values.md](financial-values.md) | Financial units, BigInt/Decimal representations, validation and settlement |
| [money-budget-boundaries.md](money-budget-boundaries.md) | Monetary constraints, budget reservations and write boundaries |
| [manual-review.md](manual-review.md) | Operator handoff and unresolved execution outcomes |
| [scheduled-tasks.md](scheduled-tasks.md) | Scheduled intent dispatch and authorization |
| [test-cases.md](test-cases.md) | Test layers, regression invariants and browser journeys |
| [known-risks.md](known-risks.md) | Simulation boundaries and unverified deployment properties |
| [pi-upgrade.md](pi-upgrade.md) | Pi dependency integration notes |

Files named `*-report.md` and `repair-*.md` are historical investigation or acceptance records. They preserve evidence from a particular run and are not specifications for the current implementation. Do not use their test counts, commands or former compatibility behavior as current contracts.

## Maintenance rules

- Write new documentation in English. Use real module paths, API fields and tool names.
- Keep each document focused and link to the owning document instead of repeating its implementation detail.
- Document current behavior. Keep chronology and run-specific measurements in historical reports or Git history.
- Distinguish code-enforced behavior, simulated behavior and unverified properties. Do not infer production guarantees from local tests.
- Use pnpm commands from `package.json`; do not introduce npm or npx setup instructions.
- Financial inputs use decimal strings. State units explicitly: booked CNY cents, unrounded CNY estimates and dimensionless yield ratios have different contracts.
- Describe only the current schema and API contracts. There is no supported conversion of older databases or fallback to obsolete response shapes.
- Describe SDK execution fences through the trusted invocation context and transaction checks. Do not document the removed Symbol-based input fence.
- Require verified current receipts for committed-result replay. Missing evidence is an integrity or reconciliation case, not permission to reconstruct a result or repeat a write.
- Do not read or expose `.env.local` credentials while updating documentation. Configuration examples must use placeholders.
- Update affected documents alongside changes to their owning modules; validate referenced paths, command names and contracts before reporting completion.

## Related context

- [Root context](../CONTEXT.md): repository routing and cross-module conventions.
- [Integration test context](../tests/integration/CONTEXT.md): detailed cross-module regression index.
- [Browser harness context](../tests/e2e/CONTEXT.md): executable prerequisites and harness mechanics.
- [Project README](../README.md): project overview, quick start and documentation entry point.
