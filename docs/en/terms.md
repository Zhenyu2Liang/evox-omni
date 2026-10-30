# Glossary

**English** | [简体中文](../cn/terms.md)

The Chinese explanations use the names in the table below.
Code identifiers, interface names, and status values remain in their original English form.

| Chinese name | English or code identifier | Meaning |
| --- | --- | --- |
| Bank agent | Agent | The runtime component that understands requests and proposes bank tool calls |
| WeChat channel | `channels/weixin/` | The communication process that hands text private chats from QR-code-bound users to the bank agent |
| Reply queue | outbox | Replies saved before sending along with send progress, used for resending after failure |
| Run | `AgentRun` | The execution process of one registered input |
| Model request | `ModelRequest` | One request to the model service for a saved round of context |
| Tool call | `ToolInvocation` | A single tool execution with a server-side identity |
| Event log | `AgentRunEvent` | Events saved by sequence number within a run |
| Operation record | `ActivityRecord`, `/activity` | Business events viewed by ordinary users, including type, time, status, and verification facts |
| Operation audit | `AuditEntry`, `/audit` | Risk-control decisions and execution evidence in developer mode, including technical details |
| Developer mode | developer mode | A display preference for demo diagnostics and maintenance; it does not constitute production administrator authentication |
| Checkpoint | checkpoint | The complete persisted state from which execution can be resumed |
| Execution lease | lease | Time-limited execution ownership |
| Commit check | fence | A check at commit time that the executor still holds ownership |
| Operation key | operation key | A server-side key used to identify and deduplicate business operations |
| Request digest | request digest | A digest of the canonical input, used to detect parameter changes |
| Identity determination | identity, `phoneIdentityMatches` | Determining a unique object by character-for-character equality of the full number; can bind an execution object |
| Candidate screening | candidate, `phoneCandidateMatches` | Narrowing candidates using masked numbers or digit fragments; does not bind an execution object |
| Identity resolution | resolution | The server resolves a selector to a unique resource id during the park stage |
| Clarification | clarification | A rejection result when the request lacks required information; requires the missing fields to be supplied and does not apply default values |
| Information completeness | `needsInput` | Whether this round's processing information still needs to be supplemented; `false` does not mean authorization has been granted |
| Model call budget | `ModelBudgetState` | Upper limits for total model calls, reserved tokens, and total duration in a single round |
| Full number | `Contact.phoneFull`, `Card.numberFull` | A fictitious full mobile phone number or card number used only for exact server-side matching |
| Mask | mask, `lib/mask.ts`, `numberMasked` | A masked number for display, keeping only the last 4 digits |
| Card last digits | `cardTail` | The last 4 digits of the card number, used only to narrow candidates |
| Execution receipt | `ExecutionReceipt` | The complete original result of a committed business operation |
| Replay | replay | Reading and returning the saved original result |
| Retry | retry | Re-executing the same call and increasing the attempt count |
| Recovery | recovery | Continuing the original run or workflow from persisted state |
| Manual reconciliation | reconciliation | Manual verification of evidence when the result cannot be proven |
| Pending-confirmation operation | `PendingAction` | The original operation awaiting user confirmation or authentication |
| Multi-factor authentication | MFA | A strengthened identity authentication mechanism for high-risk operations |
| Verification code challenge | `MfaChallenge` | A single verification record binding the original operation and the command digest |
| Challenge consumed | `consumed` | The state in which a challenge has been used up by one decision; re-verification is rejected as a terminal state and the challenge is not reissued |
| Challenge expired | `expired`, `command_changed` | The state in which the challenge is past its validity period or the command has changed; the gateway re-signs the challenge accordingly |
| Rejection reason determination | `mfa.attemptState`, `mfa.challengeInvalidation` | The sole source for whether this operation has exhausted its attempts and why the challenge is unavailable |
| Conflict | `CONFLICT` | A rejection result when the state has changed or the snapshot no longer matches; nothing is written this time |
| Structured security failure | `SecurityFailure` | Typed fields provided by the server on rejection, used by the caller to render the message |
| Lock | `locked` | The terminal state an operation enters after verification code failures reach the limit; unlocking the account does not change this state |
| Security circuit breaker | circuit breaker, `security/circuit-breaker.ts` | A restriction applied per account owner (`user:<userId>`) after consecutive failures reach the limit, covering every tool call by that owner |
| Seal | seal, `sealReason` | The planning layer's handling that marks a node as unable to continue driving, because of a lock rejection or because the operation has left the open state |
| External message finalization | `lib/public-text.ts`, `lib/tool-feedback.ts` | The sole exit through which internal diagnostics are converted into user-visible text |
| Internal diagnostic | internal diagnostic, `lib/internal-text.ts#isInternalDiagnostic` | Diagnostic text such as protocol payloads, JSON fragments, and stack traces, which does not enter public text |
| Workflow | workflow | A business execution process composed of nodes and dependencies |
| Directed acyclic graph | DAG | A task graph with no circular dependencies |
| Budget envelope | budget envelope | An accounting budget; does not freeze withdrawable funds |
| Booked amount | booked amount | The integer-cent amount already committed to the ledger |
| Valuation | valuation | A value estimate not yet rounded to the booked amount |
| Settlement | settlement | The write convention that rounds an unrounded valuation once to the cent according to `HALF_UP` |
| Annualized return rate | `annualYieldRate` | A dimensionless ratio, converted to a percentage for display |
| Net asset value | `latestNetValuePerUnit` | The price per unit of holding, canonical decimal text, kept to 4 decimal places |
| Units | `shares` | Number of units held, canonical decimal text, kept to 6 decimal places |
| NAV date | `latestNetValueDate` | The business date corresponding to the net asset value, displayed in UTC+08:00 |
| Position market value | `marketValue` | The unrounded valuation of `份额 × 净值` |
| Remaining position cost | `principalAmountMinor` | The position cost remaining after redemption, deducted in proportion to units |
| Position profit | unrealized profit | Unrealized profit, equal to position market value minus remaining position cost |
| Realized profit | `realizedProfitMinor` | The difference between the amount received on each redemption and the cost it consumed; may be negative |
| Cumulative profit | cumulative profit | The sum of realized profit and position profit |
| Full redemption | full redemption, `ALL` | Redeeming all units and closing the position |
| Partial redemption | partial redemption, `SHARES`, `AMOUNT` | Redeeming part of the units, with the remaining units and cost continuing to be held |
| Redemption mode | redemption mode, `mode` | `SHARES`, `AMOUNT`, or `ALL`; missing or mixed modes are rejected as a clarification |
| Additional subscription | `addedToExisting` | Subscribing again to a product already held, merging into the existing position |
| Banking business tool library | SDK, `banking-sdk/` | Executes simulated banking business for the owning user |
| Debit card | `DEBIT` | A bank card bound to the holder's current account, with purchases deducting cash from the account |
| Credit card | `CREDIT` | A bank card that uses a credit limit and is not bound to a settlement account |
| Virtual card | `VIRTUAL` | A virtual debit card applied for via the card page or the agent, bound to the holder's current account |
| Settlement account | settlement account, `Card.linkedAccountId` | The holder's current account from which debit card and virtual card purchases are deducted |
| Link status | `linkedAccountStatus` | The result of linking a card to a settlement account: `LINKED`, `MISSING`, `UNTRUSTED`, `NOT_APPLICABLE` |
| Account balance | `accountAvailableBalance` | The available cash in the settlement account |
| Available balance | `payableAmount` | The amount currently spendable on this card, the smaller of the account balance and the remaining monthly limit |
| Available status | `usable` | Whether the card can currently be used for purchases, equal to `status` being `ACTIVE` |
| Report loss | `LOST` | The card's terminal state; it cannot be frozen, unfrozen, or reported lost again, only replaced |
| Replacement | replacement, `replaceCard` | Replacing a card reported lost with a new card; the original card remains `LOST` |
| Monthly limit | `monthlyLimit` | The card's cumulative monthly spending cap, calculated across cards before and after replacement combined |
| Card purchase | `CardConsumption` | A successful locally simulated purchase record, including amount, category, merchant, and server-side purchase time |
| Signed 64-bit integer | INT64 | The database storage range for the current booked amount |
| Green permission | GREEN | Current policy allows automatic execution |
| Yellow permission | YELLOW | Requires user confirmation before execution |
| Red permission | RED | Requires multi-factor authentication before execution |
| Mock model | mock | Uses scripted replies and does not contact the model provider |
| Live model | live | Requests the configured model provider |

MFA stands for Multi-Factor Authentication.
DAG stands for Directed Acyclic Graph.
SDK stands for Software Development Kit.
MFA currently uses simulated verification codes; for capability boundaries, see [Current limitations](known-risks.md).
