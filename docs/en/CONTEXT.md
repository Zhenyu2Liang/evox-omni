# Documentation Maintenance Rules

**English** | [简体中文](../cn/CONTEXT.md)

## Scope

These rules apply to the maintenance of `docs/cn/` and `docs/en/`.
Developers and AI must follow these rules when modifying documentation.

`docs/cn/` body text must use Simplified Chinese, and `docs/en/` body text must use English.
Chinese body text must follow the [STC skill](../../.agents/skills/stc/SKILL.md).
English body text must preserve the source text's permission conditions, numeric values, commands, and simulation boundaries.
Code, commands, file paths, and interface names must be kept in their exact form.
For language conventions of code and comments, see the user or project instructions.

## Content Ownership

Each rule must be explained in only 1 topic document per language.
Other documents must link to the corresponding topic.
The two documentation sets must use the same file names and topic scopes, and must provide a language-switching link at the top.
Topic links within the same language must preferentially point to pages in that same language.

| Content | Document |
| --- | --- |
| Documentation entry point | [README.md](README.md) |
| Implemented business features, usage entry points, and competition scenario coverage | [implemented-features.md](implemented-features.md) |
| Names and definitions | [terms.md](terms.md) |
| Environment, commands, database operations | [development.md](development.md) |
| Module responsibilities and execution order | [architecture.md](architecture.md) |
| Events, checkpoints, retries, and recovery | [agent-durability.md](agent-durability.md) |
| Financial units and settlement | [financial-values.md](financial-values.md) |
| Monthly and annual bill reports, statistical scope, export, and dedicated tests | [bill-reports.md](bill-reports.md) |
| Investment net asset value, shares, and return scope | [investments.md](investments.md) |
| Card addition and removal, settlement account binding, and balance display | [card-management.md](card-management.md) |
| Identity determination for numbers and cards, candidate filtering, full-number boundaries, and completion | [identity-resolution.md](identity-resolution.md) |
| Tool parameters, errors, and model-visible results | [tool-contracts.md](tool-contracts.md) |
| Whether string matching participates in business decisions | [string-matching-review.md](string-matching-review.md) |
| Chat cards and invocation details | [chat-presentation.md](chat-presentation.md) |
| Conversation archiving, context compaction, and original-text search | [context-compaction.md](context-compaction.md) |
| Permissions, authentication, and auditing | [security.md](security.md) |
| Manual takeover and evidence handling | [manual-review.md](manual-review.md) |
| Scheduled tasks and reminders | [scheduled-tasks.md](scheduled-tasks.md) |
| WeChat login, conversations, and confirmation commands | [weixin.md](weixin.md) |
| Pi version and interface adaptation | [pi-integration.md](pi-integration.md) |
| Test methods and evidence scope | [test-cases.md](test-cases.md) |
| Simulated capabilities and unverified conditions | [known-risks.md](known-risks.md) |

`README.md` in the project root directory must retain the project entry-point responsibility.
`README.md` uses English, and `README.zh-CN.md` uses Simplified Chinese.
The two entry points must stay synchronized on features, commands, and license statements, and must provide links at the top to switch between each other.
Detailed development instructions must be placed in `docs/cn/` and `docs/en/`.
When updating a topic, both languages must be synchronized; a summary must not replace a full translation.

## Facts and Wording

- When changing a contract, the corresponding topic must be updated at the same time.
- When describing features, implemented, simulated, and unverified capabilities must be distinguished.
- When citing test results, the execution scope and evidence source must be stated clearly.
- Old acceptance counts must not be written as current test results.
- Before adding a new name, the glossary must be checked and updated.
- When users only need the current description, duplicate fix reports must not be added.
- Old formats not supported by the code must not be written as available features.
- Documentation examples must use placeholder keys.
- Credentials in `.env.local` must not be read or disclosed.

## Modification and Verification Steps

1. Read the corresponding code and existing topic.
2. Check for overlapping content and determine information ownership.
3. Modify the paragraphs affected by the factual changes.
4. Update the table of contents and reference paths.
5. Check sentence meaning, terminology, units, and permission conditions.
6. Run the STC check command on Chinese body text.
7. Verify the source paths, section links, and language-switching entry points in both languages.

Ordinary topics must be checked per `for-document`.
These rules must be checked per `for-instruction-writing`.
Errors in machine-check reports must be fixed.
Anti-Echo doubts must be deleted or have a specific reason for retention recorded.
The machine-check G4 "actions hidden in boilerplate" and G5 "facts or quantities unclear" are frequently triggered by terminology in this repository ("已实现收益" (realized returns), "已实现功能说明" (implemented feature description), "部分赎回" (partial redemption), "实现见" (implementation see)) and are false positives; record the reason and retain them.
After documentation changes, doubts must be re-verified.
Review records may be saved to `.pnpm-store/` in the workspace.

```sh
node .agents/skills/stc/tools/cli.mjs check docs/cn/README.md --profile for-document --anti-echo
node .agents/skills/stc/tools/cli.mjs check docs/cn/CONTEXT.md --profile for-instruction-writing --anti-echo
```

Temporary files must be saved in the current workspace.
File log locations must follow the [repository logging rules](../../CONTEXT.md#operation).
Before deleting old files, unique valid facts must be written into the topic document.
After deleting old files, all references must be updated.
