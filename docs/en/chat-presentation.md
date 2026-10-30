# Conversation and Business Cards

**English** | [简体中文](../cn/chat-presentation.md)

## Reply Delivery Method

The body is displayed in full after the model request ends and passes the existing checks.
The complete transmission and reply format are handed to the page only after passing the checks.
Tool, plan, and reply stages update in real time via SSE.
The page separately displays "Generating reply," "Checking reply," and "Refining reply."
The current method does not display the model body word by word.
The competition problem statement requires secure handling and natural conversation, and does not require word-by-word streamed text.
Business cards display only real tool results, authorizations, and receipts.

The model's `stop` means the vendor has marked generation as finished.
The current OpenAI-compatible stream must also receive SSE's `[DONE]`.
If the connection disconnects after only `stop`, it is still treated as a connection failure.
Merely proposing complete tool parameters also cannot skip the stream-end check.
An incomplete response cannot be used to create authorizations or execute operations.

Neither `stop` nor `[DONE]` can prove that a sentence has been fully written.
When both are received, ordinary explanations and analyses retain the vendor's original text.
Handling status and balance statements still need to pass the fact checks described below.
Reply delivery is based on the vendor protocol, complete transmission, and persisted records.
The page does not guess truncation based on sentence-ending words, nor does it automatically fill in the second half of a sentence.
Reply format issues are corrected in the original context, at most 1 times.
An amount or old draft wording appearing alone does not trigger a re-answer.
The original candidate, correction request, and results are still saved in the run record.
For persistence rules, see [Reply Correction and Suggested Continuation](agent-durability.md#reply-correction-and-suggested-answer-continuation).

Vendor requests and responses have separate server-side audit records.
The records are associated with the actual model request and include the request body and stream-end evidence.
When records are missing, the page only indicates that transmission is incomplete and does not infer the root cause.

The chat form remains disabled until client-side event handling is ready.
Page restoration queries wait at most 5 seconds, covering both the request and JSON decoding.
Cancellation, unmounting, or read failure ends the restoration state.
Late results cannot overwrite a new conversation; existing messages and operation cards continue to be retained.

## Normal Communication

The model declares the purpose of the current round via `describe_turn`.
Purposes include communication, advice, query, and handling.
The declaration only constrains tool proposals and does not grant bank operation permissions.
Declaration calls are saved in the run record and are not displayed as chat tool cards.
The online flow does not infer purpose from words in the user's sentence.
Information completeness is expressed by `needsInput`; for the rules, see [Bank Tool Contract](tool-contracts.md#this-rounds-declaration-and-information-completeness).

During the handling preparation stage, the object and quantity may be queried first.
After the query is confirmed, planning of the handling steps in the original request may continue.
Once an operation sequence containing writes is bound, it cannot be changed.
Query confirmation cannot replace confirmation or verification codes for subsequent writes.

The communication purpose preserves normal question-and-answer.
Ordinary communication retains natural text and may use Markdown formatting.
For example, when asked about funding sources, explain the default demand account and the method for specifying an account.
When asked about scheduled task capabilities, explain the supported tasks and required parameters.
These questions do not require the model to create a task plan or operation card.

Ordinary communication can explain account situations through green queries.
The server blocks write operations and plan submissions during communication.
Queries requiring authorization also cannot generate operation cards due to capability consultation.
New user messages use a new round declaration.
The model continues to retain the user's original words, tool results, and normal explanations.
Missing user messages are backfilled from the saved conversation.
Backfilling uses only the user's original words and does not generate tool results or authorization records.
Requests and amounts in history do not represent current authorization.
New requests handle only the latest user message; casual chat does not restore old unsubmitted drafts.
The user page's historical messages and run records are still retained.
Subsequent explicit business requests still enter the original authorization flow.
Already-created operations awaiting confirmation retain their authorization records and request panels.

Whether handling is possible is validated by the current round's declaration, authorization, and execution entry points.
General rules, hypothetical examples, and quotations of historical original words remain intact.

The model may explain and analyze based on historical structured tool results.
Historical query results describe the data at the time of the query.
Historical tool results do not represent newly added execution in this round.
Historical assistant text does not provide balance or execution evidence.

Business advice retains the complete analysis and does not display only a query summary.
For example, "which subscription can be canceled" is asking for advice.
The model may compare costs, ask about usage frequency, and explain trade-offs.
The advice itself cannot cancel a subscription or submit a workflow.
Existing query results may serve as the basis for analysis with a noted timestamp.
When a new query is needed, that query still follows the red-yellow-green permission rules.
After the query is confirmed, if the user is still asking the same question, the model continues the analysis.
If the user has already sent another question, only the original query results are displayed.
The system does not automatically restore old advice questions.

Model output must also pass the reply format check.
The check identifies only complete protocol envelopes and complete reasoning-tag envelopes.
A JSON envelope must be fully parseable and conform to the protocol structure.
Ordinary business JSON, historical quotations, and code examples in the body are retained.
Explicit protocol examples are allowed through structured intent markers.
When a format issue is found, the model re-answers in full once within the original context.
If it fails again, the page states that a displayable reply cannot be generated.
The original candidate and correction results continue to be saved in the internal archive.

The correction count and stage of the same run are first saved to a checkpoint.
After a process restart, completed corrections do not request the model again.
When output reaches the token limit, it is treated as an incomplete reply.
The page displays a generation failure notice and does not substitute a blank communication template.

The model body retains independent explanations, analyses, and Markdown formatting.
The body is not used as evidence of balance, authorization, or completed execution.
The execution status of this round is described by the real results in business cards.
The format correction process cannot create authorizations or execute write operations.

A new round of messages regenerates the system rules.
When crash recovery restores an existing model request, the original request's system messages are retained.
Recovery cannot mix new rules into an already-recorded request.

## Handling Status and Balance

[reply-safety.ts](../../agent/reply-safety.ts) checks the body for statements of submission, success, and awaiting confirmation.
When a check hits, display of that candidate body is deferred.
The server generates the status based on the current round's real tool results, operations awaiting confirmation, and execution receipts.
When there is no corresponding evidence, it explicitly displays that no new operation has been created or executed.
This check is performed even if the model omits the declaration or incorrectly declares ordinary communication.

Balance statements likewise require the current round's structured account facts.
When facts are missing, state that the balance has not yet been obtained and do not adopt numbers provided by the model.
Holding descriptions display product names, and internal holding IDs remain in the structured data.

The check retains independent explanations, negative sentences, conditional examples, and historical quotations.
Internal enums and tool names in ordinary explanations are converted to business names.
When a protocol example is explicitly requested, the corresponding code identifiers are retained.
Word matching only filters statements to be verified and does not prove that a transaction has been executed.
For the complete rules, see [String Matching Review](string-matching-review.md#reply-fact-checking).

A new model request reads the operation status of the current user and current session.
It reads only the most recent 10 status entries of registered chat tools and does not project parameters or verification codes.
The server synchronizes the terminal states of historical tool results in the request view.
Operations that have been canceled are no longer described as awaiting confirmation.
The original archive and the order of tool calls remain unchanged.
When an existing model request is restored, its original input is retained.

## Invalid Amounts

The amount parameters of tools and plans use exact decimal strings.
The server checks parameter types, precision, and the amount ranges for the corresponding business.
When parameters are invalid, creating authorizations or submitting financial commands is stopped.
Transfer, subscription, and budget amounts must be greater than 0.
Spending limits may be set to 0; negative limits are still invalid.
Explanations, hypotheses, and historical reviews about negative numbers continue as normal communication.
The simulated model may explain invalid amounts according to the offline script.
The online flow retains the complete user original words and does not parse amounts before input.

## Historical Messages

Normal use continuously saves the complete conversation and original model messages.
Display pagination and model context compression do not delete archived records.
The chat page initially displays the most recent 20 messages.
Users can click "Load earlier records" to read the previous 20 messages each time.
Messages are displayed in their original order, and the current reading position is retained after loading.
Each tool call occupies 1 independent records.
Records include the business name, status, and the result card for that call.
Assistant body text occupies another 1 messages, and each individual body remains complete.

The history page locates messages by message identifier, so no message is missed even with identical timestamps.
When reading history, the server supplements the current authorization and workflow status.
Earlier pending-confirmation cards may display subsequently executed or canceled statuses.
After new messages are appended, the original pagination identifiers remain valid.

When a developer clears the conversation, the server changes the history version identifier.
Pagination requests from the old version cannot join the new conversation.
When the page indicates that history has changed, it re-reads the current conversation.
Ordinary refresh only reads records and does not delete the archive.

After a reply connection is interrupted, the page reads the most recent 20 saved messages.
This read waits at most 5 seconds and does not resubmit financial requests.
A saved complete answer updates the original message and does not display the user input again.
The original history pagination and already-loaded messages continue to be retained.
Incomplete streamed text is not saved as a final answer.
The page retains the connection interruption notice so the user can check the operation records.
After the conversation is cleared, old requests and old restoration results cannot join the new conversation.

When word-by-word review of history is needed, the model may query the original conversation archive.
Archive queries return only user and assistant text.
Tool results and authorizations still use their respective execution records.

## Business Facts

Normal mode displays business results; developer mode displays call details.
Cards use only tool results, execution credentials, and authorization records.
Model text and call parameters cannot serve as evidence of successful operations.

## Tools and Cards

| Tool | Display in Normal Mode |
| --- | --- |
| `get_balance` | Available balance and account list. |
| `search_conversation_history` | Chat record query progress; the model quotes matching original words. |
| `get_transactions` | Merchant, category, time, and signed amount. |
| `search_contact` | Matching contacts, masked mobile numbers, and banks. |
| `analyze_spending` | Spending totals, categories, trends, and merchants. |
| `detect_anomaly` | Suspicious transactions, risk levels, and reasons, as well as entry points for flagging, details, and freezing cards. |
| `get_dashboard_summary` | Asset overview and query time. |
| `get_cards` | Card status, masked card number, and limit. |
| `set_card_limit`, `freeze_card`, `unfreeze_card` | Updated card information. |
| `report_lost_card` | Card information after reporting loss. |
| `list_subscriptions` | Subscription price, cycle, billing date, and reminder. |
| `cancel_subscription`, `set_subscription_reminder` | Updated subscription status and reminder. |
| `list_investments`, `compare_investments` | Product, risk, yield, term, and minimum purchase amount. |
| `get_investment_holdings` | Holding facts and status; fields and default rules are described below. |
| `subscribe_investment`, `redeem_investment` | Settlement receipt (amount, post-operation balance, record time, and settlement credential) and the holding card re-read after submission. |
| `reserve_budget` | Budget name, amount, status, purpose, and deadline; the card notes that this record does not deduct funds or freeze balance. |
| `list_scheduled_tasks`, `create_scheduled_task` | Name, type, scheduled time, status, and confirmation requirements. |
| `transfer_money` | Payee, transfer amount, and post-operation balance. |
| `submit_plan` | Workflow steps, status, and control entry points. |

Holding cards for wealth management writes come from a re-read after the write submission.
`agent/tools/investment.ts#withHoldings` re-reads that user's holdings only after the write submission.
`agent/card-emitter.ts#toCards` places the re-read result as the holding card of the same call after the settlement receipt, using the same holding data as `get_investment_holdings`.
When the re-read result is unavailable, only the settlement receipt is displayed: the write has already been submitted, no empty holding list is fabricated, and no error card is appended.
The pre-write holding snapshot never becomes the latest holding card after the write.
When the re-read result is empty, an empty state indicating no holdings is displayed.
Holding facts are uniformly rendered by `components/banking/HoldingFacts.tsx`.
`card` and `tile` only switch layout and retain the same fields:

- Shares, net asset value, NAV date, and market value.
- Remaining holding cost, holding gain, and holding return rate.
- Cumulative gain and realized gain.

Market value is derived as shares multiplied by the latest net asset value.
Missing facts display "insufficient historical data" and are not filled with 0.
When there are no shares or no net asset value, the valid historical valuation is retained and marked "to be verified."
Only when historical valuation is missing does it fall back to cost.
When using these two fallbacks, holding gain, holding return rate, and cumulative gain are not displayed.
Totals are summed only over holdings whose status is held; if any holding lacks market value or holding gain, the corresponding total is not displayed.
The return basis explanation is displayed only for holdings that are all valued under the net asset value model.
For NAV basis, shares, and return rules, see [Wealth Management NAV, Shares, and Return Basis](investments.md).

Cards display only masked card numbers and card facts.
When `linkedAccountStatus` is `LINKED`, display the linked account name, masked number, account balance, and available balance.
When `MISSING` or `UNTRUSTED`, do not display any balance fields and provide only an explanation of the binding exception.
When `NOT_APPLICABLE`, do not display the linked account and retain the credit limit and available credit.
When `usable` is false, display an unavailable explanation; `FROZEN` and `LOST` still display the real account balance.
Multiple virtual cards of the same account share that account's balance, and the asset total counts it only once.
Masks and last digits are used only to narrow candidates, not as identity; identity matches only full numbers or precise identifiers already held.
For binding, shared balance, and identity determination rules, see [Card Management](card-management.md) and [Identity Determination](identity-resolution.md).

When confirmation or verification is needed, display the request panel above the input area.
After actual execution is complete, display the corresponding result card.
Continuing after confirmation and checkpoint recovery use the same mapping.
On refresh, restore results according to the original authorization record to avoid duplicate cards.
Authorization results for financial write operations are generated directly by the server.
Neither the simulated model nor the online model re-runs the model to announce write operation results.
Query or advice questions still being processed may continue generating analysis after confirmation.
That continuation uses only the confirmed query results and cannot submit write operations.
Delayed confirmation only updates the original tool result and retains conversations received in the meantime.

Financial query and execution results are displayed by the server based on actual records.
Business cards describe actual results according to authorization status and execution credentials.
The assistant body independently displays natural explanations and advice.
Adding and removing demo cards uses the [Card Management](card-management.md) page.

## Task Plans

Each plan is displayed only once in the tool record to which it belongs.
New states produced by authorization, execution, and recovery update the same card.
Completed and canceled plans are retained as historical records.
After the user sends a new message, old plans are not moved to the bottom of the conversation.

When the page is refreshed, the actual states of plans and nodes are read from the database.
The original run and tool call identifiers are used to determine the message to which they belong.
When a subsequent authorization run publishes an old message again, its belonging run is not changed.
When the belonging record is missing, an independent plan record is inserted according to the plan creation time.
After a developer clears records, only plans within the scope of the new records are restored.

The pause, resume, cancel, and retry buttons always submit the plan identifier of that card.
Buttons on old cards do not control plans created later.
Updates from older execution generations cannot overwrite newer states.
Within the same execution generation, snapshots with older times cannot overwrite newer states.
Newer execution generations take precedence and are not affected by server clock rollback.
State changes with the same timestamp are processed in the order received.
Completed plans are not changed back to in-progress by delayed progress messages.
Cancellation and compensation supported by budgets or scheduled tasks still use explicit plan control requests.

## Normal Mode

The maximum width of the desktop message area is 1152 px.
The assistant body is displayed left-aligned, with a maximum width of 832 px.
User messages are displayed right-aligned, with a maximum width of 640 px.
Identity markers are displayed on both sides, and the body width adjusts with content and screen.
Business operations are displayed independently, with the left edge aligned with the assistant body.
Mobile pages retain left-right distinction, and tables scroll horizontally within cards.

Business cards use compact titles, metric areas, and responsive grids.
Tool progress uses business names and actual statuses.
Each call and result is displayed as an independent record in order.
Query results may be displayed first, and assistant analysis then appears as a separate message.
Subsequent statuses update the original record, and tools are no longer repeatedly displayed at the bottom of the chat.
Confirmation and verification code input are displayed only in the request panel above the input area.
The panel does not scroll with the message list and collapses after processing is complete.
In short viewports, only the operation details scroll, while the title and buttons remain visible.
When the verification code is incorrect, the panel remains and explains the error.
When switching to the next operation, the verification code input is cleared.
After the page is refreshed, pending requests are restored, but verification code drafts are not restored.
The belonging call retains a read-only authorization record and does not provide a confirmation button.
The record displays the confirmation requirements at the time of initiation and the current processing status.
When authorized but not yet executed, display "Authorized, processing."
Completed, canceled, failed, and verification locked are displayed separately.
When the result is unknown, display pending verification and do not display completed.
When earlier belonging records have not been loaded, the request panel is still usable.
When a result card already exists, the success summary is not expanded again.
Unknown tools use generic business names and do not display raw tool names.
Confirmation requests retain the payee, amount, and risk level.
Locking is the terminal state of an authorized operation; the page no longer displays verification input, nor does it display a confirmation or verification panel for that operation.
The top-level `CIRCUIT_OPEN` is distinguished by `failure.reason`: `mfa_attempts_exhausted` renders `chat.error.actionLocked`; `circuit_open` and `mfa_session_locked` render `chat.error.securityLocked`.
Confirmation, verification, and cancellation during manual review render only `chat.error.manualReviewHold` and do not use the "business status has changed" notice.
The remaining count is rendered only by `lib/public-text.ts#securityNotice`; `attemptsLeft ?? 0` of `securityNoticeParams` is the only default value, and negative values are displayed as-is.
Internal markers such as `__SECURITY_BLOCK__` payloads, JSON fragments, and stack frames never enter public copy; `lib/internal-text.ts#isInternalDiagnostic` is the sole determinant, and `lib/public-text.ts` is the sole exit.
Delayed confirmation or verification events cannot reopen an operation that has already ended.
Reply events, message content, and card data are validated before being displayed.
Unreadable formats display an error notice and are not passed directly to the card component.

Amounts use the existing integer-cent formatting function.
Valuations and return rates use the Decimal formatting function.
Redeemed positions are not included in the current position total.
When a valuation is missing, do not fill the unknown value with principal or zero.
Cancelled subscriptions do not display future deduction notices.
Creating a budget does not represent a deduction or a hold on funds.
Creating a scheduled task does not mean the payment has been completed.
The system has no password credentials and does not provide a password change tool.

## Developer Mode

Once enabled, "View Call Details" can be expanded on each call.
The details show the original tool name, call identifier, and operation identifier.
Parameters come from the actual record of that call and are not inferred by the frontend.
When there is no parameter record, the interface clearly states that none was recorded.
Once disabled, the details are removed from the conversation interface.

The server first redacts parameters and checks again before display.
Passwords, verification codes, keys, tokens, and credential text are all hidden.
Phone numbers keep only the last 4 digits.
Reasoning content does not enter call details.
The depth and size of nested data are limited to avoid filling up the interface.
Raw call events are still kept in the run records.
Model correction instructions and unknown error diagnostics are shown only in developer details.
Normal mode uses business error descriptions and retains specific reasons such as insufficient balance.
Page error notices and task failure descriptions also use the same rules.
Public error codes retain business categories such as resource not found and validation failed.
Verification code remaining attempts, expiration, and used status retain specific descriptions.
Unknown runtime errors are shown only in redacted developer details.

## Code Entry Points

- [Card mapping](../../agent/card-emitter.ts).
- [Business result validation](../../agent/business-card-payloads.ts).
- [Purpose declaration for this turn](../../agent/tools/turn-intent.ts).
- [Body retention](../../agent/conversational-response.ts).
- [Historical tool evidence](../../agent/conversation-evidence.ts).
- [Amount range check](../../agent/tools/plan-parameters.ts).
- [Card dispatch](../../components/chat/cards/CardRenderer.tsx).
- [Tool activity and details](../../components/chat/ToolEventList.tsx).
- [Parameter redaction](../../lib/tool-diagnostics.ts).
- [Authorization result recovery](../../agent/transcript-activity.ts).
- [Plan history recovery](../../app/agent/plan-history.ts).
- [Plan card attribution](../../lib/chat-plan-history.ts).
