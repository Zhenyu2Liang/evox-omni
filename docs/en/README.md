# Development Documentation

**English** | [简体中文](../cn/README.md)

When running the project for the first time, read the [Development Guide](development.md) first.
Before modifying business logic, read [Architecture Design](architecture.md).
Names in the documentation follow the [Glossary](terms.md).

## Choosing Documentation by Task

| Task | Documentation |
| --- | --- |
| View implemented business, usage entry points, and competition scenario coverage | [Implemented Features Description](implemented-features.md) |
| Install, configure models, or start services | [Development Guide](development.md) |
| Converse with the bank agent via WeChat | [WeChat Channel](weixin.md) |
| Verify dependency versions or upgrade development tools | [Dependency Versions and Upgrades](development.md#dependency-versions-and-upgrades) |
| Configure reverse proxy, trusted access addresses, or per-turn model call limit | [Trusted Access Addresses](development.md#trusted-access-addresses), [Per-Turn Model Call Budget](development.md#single-turn-model-call-budget) |
| Find module responsibilities and request execution flow | [Architecture Design](architecture.md) |
| Modify event logs, retries, or crash recovery | [Persistence and Recovery](agent-durability.md) |
| Modify conversation archiving, Pi official compaction, or verbatim search | [Context Compression](context-compaction.md) |
| Modify amounts, interest rates, valuations, or settlement | [Financial Numerics and Settlement](financial-values.md) |
| View or modify monthly reports, annual reports, or bill exports | [Bill Reports](bill-reports.md) |
| Modify wealth management subscriptions, redemptions, net values, shares, or return calculation basis | [Wealth Management Products: Net Values and Shares](investments.md) |
| Modify business cards, tool progress, or developer details | [Conversational Business Cards](chat-presentation.md) |
| Modify card add/remove, settlement account binding, or balance display | [Card Management](card-management.md) |
| Modify selection of payees or cards, number masking boundaries, or number completion | [Number and Card Identity Resolution](identity-resolution.md) |
| Determine whether string matching participates in business decisions | [String Matching Review](string-matching-review.md) |
| Modify tool parameters, error messages, or model-visible results | [Bank Tool Contract](tool-contracts.md) |
| Upgrade Pi or modify streams, hooks, and tool messages | [Pi Interface Adaptation](pi-integration.md) |
| Modify permissions, confirmations, authentication, or auditing | [Security Design](security.md) |
| Distinguish ordinary operation records from developer operation audits | [Security Design](security.md#operation-records-and-operation-audits) |
| Simulate backend verification in developer mode | [Manual Verification](manual-review.md) |
| Modify expiry reminders or scheduled transfers | [Scheduled Tasks](scheduled-tasks.md) |
| Run tests or judge acceptance evidence | [Testing Guide](test-cases.md) |
| Determine simulation capabilities and deployment conditions | [Current Limitations](known-risks.md) |
| Add or update documentation for the project | [Documentation Maintenance Rules](CONTEXT.md) |

## Code and Requirements Entry Points

- The project README's [Chinese version](../../README.zh-CN.md) and [English version](../../README.md) provide an introduction and startup commands.
- [Competition Requirements](../../req.md) provide the competition evaluation context.
- [Interface Contract](../../lib/contracts) defines fields and tool rules.
- [Database schema](../../prisma/schema.prisma) defines persistent records.
- [Repository Context](../../CONTEXT.md) provides the maintenance entry point for the code directory.

Whether a feature is available is determined by the code and reproducible tests.
The current guide describes the supported contracts and limitations.
Historical fix processes and past acceptance counts can be found in Git history.
