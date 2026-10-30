# String Matching Review

**English** | [简体中文](../cn/string-matching-review.md)

Business semantics are understood by the bank agent, and execution conditions are verified by structured data.
Regular expressions are used for protocols, field formats, masking, search, and reply fact checking.
Word matching cannot rewrite user requirements or prove the outcome of financial operations.

## Current Rules

The production execution flow does not distinguish purposes by natural-language word lists.
The code that directly generates scripted replies based on word lists is located in `agent/providers/mock/`.
The online model declares the purpose of the current round via `describe_turn`.
The declaration is written to the event log as a tool call, but is not displayed as a chat tool card.

The declaration contains the following structured information:

- Purpose: `conversation`, `advice`, `query`, or `operation`.
- The capability names, repetition count, and order for the current round.
- Whether a workflow is required (`workflow`).
- Whether processing information still needs to be supplemented (`needsInput`).
- Whether a development protocol example must be displayed (`allowProtocolExamples`).

The purpose of the current round cannot be changed midway.
The server rejects rewriting the purpose or the already-bound write sequence within the same round.
During the operation preparation stage, prerequisite queries may be declared first.
After the queries determine the object and quantity, the complete write sequence is then bound.
Once the sequence contains writes, it cannot be expanded or replaced.
Each new user message re-declares the purpose.
Original messages and historical context are always stored by Pi.
The online intent contract stores the purpose, capability sequence, invocation identity, and original text.
Information completeness is expressed by `needsInput`.
The contract additionally contains `workflow`, `allowProtocolExamples` 2 presentation switches.
The contract does not parse references, conditions, or drafts.
For rules on declaration fields, see [Bank Tool Contract](tool-contracts.md#this-rounds-declaration-and-information-completeness).

Tool parameters and task graphs are verified independently.
Before a plan is submitted, the public parameter contracts of all nodes are checked.
Type conversions, unknown fields, and invalid amounts are rejected by validation.
Tool execution also requires owning-user validation, confirmation, and multi-factor authentication.

The workflow checks the number and order of writes in the declaration.
The order is verified against the stable topological order of the task graph.
Additional queries may serve as prerequisite nodes.
Plan validation does not add or replace dependency edges, amounts, or operation objects.

Time validation only handles `runAtLocal` or integer `runAt`.
When 2 fields are provided at the same time, the field values must be consistent.
Dates in the user's sentence do not override declared parameters.

Model failures use structured evidence from the vendor and transport.
Non-transient status codes such as `400`, `401`, and `403` are not automatically retried.
`408`, `429`, and server failures may be retried.
Network failures, read timeouts, and missing termination frames may be retried.
When the caller cancels the request, no automatic retry is performed.
Retries must also check the run state to prevent duplicate execution of financial writes.
Error text is for diagnostics only and cannot change retry decisions.

## Scope

The following directories contain string matching, divided into 4 categories by purpose.
This includes protocol and field formats, masking and search, closed enums, and reply fact checking.
The basis for determining business execution semantics is described in the next section.

- `agent/`: model input, reply presentation, tool orchestration, and recovery.
- `security/`: permissions, authentication, identity binding, and risk records.
- `lib/`: field parsing, database queries, internationalization, and masking.
- `app/`, `components/`: API and page state.
- `banking-sdk/`, `planner/`, `audit/`: business execution, task graphs, and auditing.

## Sources for Determining Business Semantics

The following semantics are determined only by structured fields.
Word matching cannot substitute for any of them.

| Semantics | Basis for determination | Code location |
| --- | --- | --- |
| Purpose and capability sequence for the current round | Structured declaration of `describe_turn` | `agent/tools/turn-intent.ts` |
| Whether the declaration can be rewritten | The server rejects rewriting based on purpose and write sequence | `agent/intent-context.ts` |
| Plan steps, conditions, and time | Task graph nodes, condition fields, and explicit time fields | `agent/tools/plan-compiler.ts` |
| Tool parameters | Public parameter schema; unknown fields and type conversions are rejected | `agent/tools/plan-parameters.ts` |
| Payee and card | Full number or exact own ID | `security/recipient-resolution.ts`, `lib/banking-selectors.ts` |
| Execution result | `outcome`, `needsReconciliation`, and `status` | `agent/grounding-facts.ts` |
| Retry decision | Vendor status codes and transport structure | `agent/providers/model-failure.ts` |
| Error classification | `AppError.code` and resource type | `agent/task-fencing.ts`, `lib/db/repositories/task.ts` |
| Suspected injection | Audit deduplication only; does not change permissions or circuit breaking | `security/injection-guard.ts`, `security/incidents.ts` |
| Execution key | Server-generated action, task, node, or invocation identifier | `agent/financial-operation-key.ts` |

When step order, conditions, and operation objects are needed, the confirmation card displays the task graph.
What the user confirms is the explicit object, amount, time, and operation content.
Confirmation cannot bind a natural-language string that the model can continue to modify.

## Identity Binding and Execution Results

Execution identity uses only the owning user's real resource fields.
Search text is used to return candidates and cannot directly prove the selected identity.

| Location | Matching limitation | Current rule |
| --- | --- | --- |
| Identity determination in `lib/phone.ts` | Numeric fragments and masks cannot determine the payee phone number. | `phoneIdentityMatches` only accepts character-by-character equality of the complete 11-digit number. |
| Candidate filtering in `lib/phone.ts` | Fragments and fixed masked shapes can only narrow candidates. | `phoneCandidateMatches` and `searchPhoneMatch` only return candidates. |
| Cross-field matching in `security/recipient-resolution.ts` | A name cannot be treated as `contactId`. | Each field matches only its own meaning. |
| Candidate union in `security/recipient-resolution.ts` | Contradictory fields may leave an executable candidate. | All provided fields must hit the same contact. |
| Alias conversion in `lib/banking-selectors.ts` | Card tails and product codes cannot be treated as resource IDs. | The `*Id` field binds only exact IDs, case-sensitive. |
| Result text scanning in `agent/grounding-facts.ts` | Mentioning "pending verification" does not prove the result is unclear. | Only `outcome`, `needsReconciliation`, and `status` are recognized. |
| Error prefix in `agent/task-fencing.ts` | Changes in error wording cause incorrect aborts or continued recovery. | Use `AppError.code` and the resource type. |
| Missing node error in `lib/db/repositories/task.ts` | Prisma already provides a missing-record error code. | Map `P2025` to typed `NOT_FOUND`. |
| Attack word scanning in `security/injection-guard.ts` | Quoting an attack sentence or a normal request may also match. | Write audit observations only; cannot determine permissions. |
| Suspected injection count in `security/incidents.ts` | Word hits do not prove actual privilege escalation. | Write deduplicated records only; do not accumulate signals or lock accounts. |

Actual unauthorized access and business failures can still trigger circuit breaking.
Financial results are still determined by execution receipts, ledgers, and structured states.
For the current rules on identity determination, candidate filtering, and the card selector, see [Number and Card Identity Resolution](identity-resolution.md).

## Reply Fact Checking

[reply-safety.ts](../../agent/reply-safety.ts) matches processing status and balance statements in the body text.
On a hit, candidate display is temporarily suspended, and the status is generated from real structured evidence instead.
When a submission is claimed despite no declaration, a single bounded intent correction may be triggered.
Such matching affects presentation and model continuation, but does not determine user intent or execution parameters.
This matching does not directly create authorizations, confirm operations, or deduct funds.
For specific behavior, see [Processing Status and Balance](chat-presentation.md#handling-status-and-balance).

This check uses Chinese and English sentence patterns and cannot exhaustively cover all paraphrased expressions.
Conditional examples, negative sentences, historical quotations, and standalone explanations have dedicated regressions.
Words that are not hit still cannot serve as evidence of financial execution.
Authorization boundaries continue to be determined by tool calls, pending-confirmation operations, and execution receipts.

## Retained Deterministic Matching

These matches handle defined protocols or fields.
Correct format does not mean the field has obtained execution permission.

| Module group | Retained content | Basis for determination |
| --- | --- | --- |
| `providers/completion-transport.ts` | `data:`, line breaks, and `[DONE]` | SSE protocol termination conditions. |
| `components/chat/actions.ts` | SSE frame boundaries, content types, and error code allowlist | Transport protocol and event contract. |
| `providers/model-audit.ts` | Response header name allowlist | Restricts stored response metadata. |
| `providers/provider-live.ts` | Environment variable name character normalization, vendor enum | Configuration name conversion. |
| `agent/tools/money-schema.ts`, `agent/tools/decimal-schema.ts` | Unsigned amount syntax, decimal place limit, and normalized text | Parameter format validation. |
| `money.ts`, `decimal.ts` | Precision, exponent format, and thousands separators | Financial field parsing; calculations use BigInt or Decimal. |
| `business-card-payloads.ts` | Amount, month, and business status formats | Data contract for tool result cards. |
| `banking-sdk/transaction.ts`, `app/bills/page.tsx` | Month fields | Check `YYYY-MM`. |
| Date field of `scheduled-time.ts` | Local time format and valid dates | Explicit time field conversion. |
| `MfaCard.tsx`, `CardChangeDialog.tsx` | 6-digit verification code and amount format | Form format validation; the server continues authentication. |
| `ContactManager.tsx` | Canonical phone number format | Contact form field validation. |
| `lib/mask.ts` | Display masking of phone numbers, account numbers, and card numbers | Display only; does not validate digit count or determine identity. |
| `agent/tools/result.ts` | Internal field name set, 11-digit number shape | Strips server-side identity fields and masks phone numbers. |
| `agent/banking-guidance.ts` | Single-key `guidance` envelope, closed field word list | Renders server templates only; free-form body text is discarded. |
| `lib/internal-text.ts` | Shapes of `__SECURITY_BLOCK__`, JSON fragments, and stack traces | Determines internal diagnostics; does not determine business semantics. |
| `chat-history.ts` | Cursor characters and length | Pagination protocol validation. |
| `contracts/tool-output.ts` | Numeric segments of array paths | Output path type validation. |
| `context-compaction/batches.ts` | UTF-16 surrogate pair boundaries | Keeps characters intact when splitting digest input. |
| `db/url.ts` | `file:` prefix | Current database driver protocol. |
| `tool-diagnostics.ts`, `sensitive.ts` | Credential fields and secret text masking | Prevents credentials from entering the model or diagnostic pages. |
| `durable/serialization.ts` | Credential fields, Bearer, and key shapes | Masking before persistence. |
| `durable/checkpoint.ts` | Server-side masking marker | Checks whether data required for recovery is already unavailable. |
| `i18n/shared.ts` | Registered template placeholders | Internationalization interpolation. |
| `i18n/display.ts`, `tool-feedback.ts` | Server fixed copy and error templates | Affect display only; do not determine retries or permissions. |
| `AssistantMarkdown.tsx` | URL protocol allowlist | Prohibits executable link protocols. |
| `navigation.ts`, `DeveloperModeProvider.tsx` | Exact route values and path prefixes | Page navigation and display preferences. |
| `history-request.ts` | Query parameter separators | URL concatenation. |
| `repositories/contact.ts`, `conversation-history-search.ts` | Query text containment matching | Returns search candidates; cannot bind execution identity. |

For the parsing and settlement basis of wealth management net values, shares, and returns, see [Wealth Management Products: Net Value and Shares](investments.md).
Fixed error templates should preferably be changed to error codes, display keys, and interpolation parameters.
Existing matches only translate known templates; unknown diagnostics use generic prompts.
Copy changes do not affect operation results or retry permissions.
Tool errors use structured error codes; for storage rules, see [Bank Tool Contract](tool-contracts.md).

## Enums and Internal Identifiers

Closed enum matching is retained.
The matching targets come from contracts, catalogs, or persisted states.

| Module group | Matching target |
| --- | --- |
| `permission-engine`, `security-gateway` | Tool names, risk levels, and decision types. |
| `mfa`, `manual-card-management` | Authentication status and card change status. |
| `banking-sdk/card.ts`, `banking-sdk/task.ts` | Card types, prerequisite states, and task types. |
| `durable/`, `workflows/`, database repositories | Run, invocation, node, and waiting states. |
| `planner/dag.ts` | Comparison operators, field types, and node terminal states. |
| `task-decision`, `task-rollback`, `manual-review` | Operation states, rollback-capable tools, and manual verification states. |
| `transcript-activity`, `useAgentStream` | Tool event terminal states and version update rules. |
| `PlanCard`, `MfaCard`, `confirmationStatus` | Card terminal states and valid controls. |
| `RunHistory`, `ToolEventList` | States viewable by developers. |
| Execution keys and audit prefixes | Server-generated identifiers such as `nxe:` and `reconcile:`. |
| Security block prefixes | Server-generated closed block envelopes. |

Selecting the storage type by execution key prefix is protocol parsing.
The prefix cannot be provided by model body text.
States still need to be checked against the owning user, execution lease, and commit validation.

## Simulated Models and Tests

Word recognition in `providers/mock/` is used for deterministic scripts.
The online model understands business requests independently.
Production permission and financial parameter validation cannot rely on script recognition results.

The simulated model modules are grouped as follows:

- `classifier`, `discussion`, `history`: select scripted replies.
- `transfer-intents`, `card-intents`, `subscription-intents`: generate simulated tool candidates.
- `investment-intents`, `plan-intents`, `amount-parser`: simulate parameters and task graphs.
- `request-steps`, `request-amounts`, `request-conditions`: generate simulated request materials.
- `names`, `action-follow-up`, `narration`: read test materials.
- `compaction`: simulated digest protocol.

Test scripts must go through the same gateway as the online model.
Tests must not use configuration to bypass purpose declarations, confirmation, or multi-factor authentication.
Invalid script parameters must be rejected rather than guessed and corrected by production code.

## Validation Requirements

Regression tests validate boundaries and do not fix natural-language wording.
They cover at least the following behaviors:

- Small talk, suggestions, negations, quotations, and multi-turn references retain the original context.
- Negative amounts, fractional-cent amounts, and invalid dates do not create authorizations.
- Search fragments return candidates; the same fragment cannot directly bind a transfer identity.
- Tool results are displayed first, and subsequent model body text is displayed in the original event order.
- Error and success states are determined by structured fields.
- Fabricated submissions and balance statements are replaced by facts, and clarification questions are retained.
- Repeated suspected injection observations do not lock the account.
- Registered writes are not executed repeatedly after a model failure or restart.
