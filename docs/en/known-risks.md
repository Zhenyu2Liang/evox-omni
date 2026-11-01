# Current Limitations

**English** | [简体中文](../cn/known-risks.md)

The current project is a banking agent demonstration system. Accounts, bank transaction channels, and authentication services are all simulated services.
Persistent recovery cannot replace the idempotency guarantees of external bank interfaces.

## Functional and Security Boundaries

| Scope | Current behavior | Capabilities not yet provided |
| --- | --- | --- |
| Financial values | Posted amounts use integer cents; ratios and valuations use Decimal | Multi-currency settlement; amounts beyond the current numeric boundaries |
| Identity | Login-free fixed user and shared session | Production user login, separate employee login, and role-based access control |
| Authentication | Original-operation binding, validity period, failure count, and consumption state | SMS, facial recognition, or production authentication services |
| Bank writes | Local transactions with atomic commit of changes, audit, and execution receipts | Real bank, payment, and merchant interfaces |
| Model recovery | Saves requests and results, regenerates up to a retry limit | Continuing generation from the exact token position of a partial output |
| Model call limits | Shared per-round call count, reserved tokens, and total duration limit | Exact budgeting of vendor billing amounts |
| Result recovery | Restores the original result after verifying the execution receipt | Automatically determining unknown external effects |
| Workflow | Saves the original graph, node calls, and commit validation | Automatically lifting manual pauses or authorizing on behalf of the user |
| Scheduled tasks | Saves dispatch state, reminders, and due-payment workflows | Built-in persistent scheduler in the web service |
| Birthday purchases | Creates budget limits and simulated future intents | Real fund freezing and merchant purchases |
| Wealth management | Product comparison, additional subscription, full redemption, and partial redemption | A complete "suitability questionnaire" and annual reports |
| Logging | Credential redaction, with public events and internal events kept separate | Encryption at rest, retention period policies, and separate employee access control |
| Storage | Current SQLite model and write serialization | Legacy model conversion, multi-host failover, and validation against other databases |

Amounts use RMB cent precision. Posted values are limited to the signed INT64 range.
Decimal supports at most 40 integer digits and 18 decimal places.
For the numeric definitions, see [Financial Values](financial-values.md).

## Unverified Scope

The real sending and receiving of the WeChat channel is unverified.
The code for QR code login, outbound long polling, and sending is in `channels/weixin/`; the wire protocol comes from `pi-weixinbot@1.0.5`.
Automated acceptance uses a local fake protocol server; `token` is a fake value, and `/getupdates` responses are fabricated by the tests.
`channels/weixin/transport.ts`, `channels/weixin/worker.ts`, and `channels/weixin/login.ts` have no automated tests and no real-device records.
Message sending and receiving with a real account, client compatibility, session validity period, and account-level limits are unverified.
Completing verification requires a real account and phone, executing step by step from QR code login to receiving a reply.
For details, see [WeChat Channel](weixin.md).

The `MISSING` and `UNTRUSTED` branches of card association status have not been verified with real data.
`resolveSettlement` in `banking-sdk/card.ts` is determined in a fixed order: `CREDIT` is `NOT_APPLICABLE`, an empty binding is `MISSING`, a record id that is not the person's demand deposit account is `UNTRUSTED`, otherwise it is `LINKED`.
Only `LINKED` carries the account name, masked account number, and balance; for the remaining statuses these fields are absent rather than `0.00`.
These two branches are constructed only by test cases writing directly to the database.
There are four construction methods: clearing the binding, binding another user's account, binding a non-demand-deposit account, and deleting the account to trigger the foreign key `SetNull`.
Test cases are in `tests/unit/banking-sdk/card-linked-account.test.ts`.
Neither the demo seed nor the API and page flows produce these two branches, so there is no reproducible user-flow evidence.
For the definitions, see [Card Management](card-management.md).

The conclusions of live acceptance hold only for the scenarios that were run and the corresponding product tree.
See [Acceptance Evidence and Limitations](test-cases.md#acceptance-evidence-and-limitations) for recording requirements.
After product code changes, rerun the affected test cases.

Same-machine dual-server consumption races, duplicate requests, and restart recovery after commit have been verified.
These results do not cover multi-host deployment, sustained load, or cross-process races for all financial instruments.
Natural language expressions cannot be exhaustively enumerated, and real bank and real WeChat delivery remain unverified.

## Meaning of Business Results

- Wealth management subscriptions are debited from the demand deposit account, and additional subscriptions are merged into the existing holding. Redemption must declare the server-side mode `SHARES` / `AMOUNT` / `ALL`: `SHARES` redeems by shares, `AMOUNT` converts to shares by `FLOOR(金额 ÷ 净值, 6 位小数)`, and `ALL` redeems all shares. Requests exceeding the holding are rejected rather than truncated, and the entire holding is closed when the remaining shares reach zero.
- Card limits modify only the category spending cap and do not adjust the total credit line. Virtual cards are bound to a demand deposit account and support local simulated spending; real merchant payments are not integrated.
- Virtual card spending is recorded locally: a single transaction debits the bound demand deposit account and writes `CardConsumption`, without generating a real merchant or bank transaction.
- The consumption time is generated by the server; a `occurredAt` passed in by the caller is rejected.
- The monthly limit aggregates spending on the same card before and after replacement.
- Original transaction records have no card ID. The abnormal transaction freeze entry requires the user to select a card.
- Confirming one's own transaction only saves an audit record and does not remove the abnormal flag.
- Total assets equal the sum of account balances and holding valuations, without deducting credit card liabilities.
- The developer reset button in the security center only lifts the circuit breaker and does not grant the right to execute the original operation. Confirmation and authentication are still handled according to the original state.
- Directed acyclic graph (DAG) workflows commit per node; the entire plan is not a single transaction. Failure of a successor node does not roll back already-posted transactions.
- Shares of historical holdings can only be derived by the offline script `scripts/investment-share-backfill.mjs`.
- The derivation basis is `shares = FLOOR(账面市值 ÷ 净值, 6 位小数)`, and the results are marked as `shares_estimated`.
- On the read side, `valueBasis` is `MIGRATED_ESTIMATE`, and the UI labels it "estimated". Such holdings are estimates, not real subscription records.
- When a product has no published net value or the net value is zero, the script skips that row and does not fabricate shares. A negative net value aborts the entire run with zero writes.
- Market value is always derived according to `份额 × 最新净值`, with entry point `banking-sdk/investment.ts#holdingValuation`.
- Net values have at most 4 decimal places and shares at most 6 decimal places; inputs with more decimal places are rejected as parameter errors.
- `InvestmentHolding.estimatedMarketValue` is only a snapshot at write time and is not used by the read path.
- When shares or net value are missing, `valueBasis` is `HISTORICAL_DATA_INSUFFICIENT`, market value falls back to the remaining cost, and no return or return rate is given. Subscription time and net value history do not participate in valuation.
- Fees being always zero is a simulation convention: the data model has no fee column, and holdings, `Transaction`, and `CardConsumption` all record no fees.
- Redemption results retain two display fields, `feeAmount` (always `0.00`) and `feeRule` (always `SIMULATED_NONE`); the amounts are not calculated.
- The credited amount is `HALF_UP(赎回份额 × 成交净值)`, with no fee deduction. Subscriptions and virtual card spending are recorded only at the requested amount.
- The fee field is not in the redemption confirmation snapshot, so a change in fee convention will not invalidate a pending action. Real fee rates, minimum charges, and fee refund rules are unverified.
- SQLite statements and transactions within the same process are executed serially through a FIFO mutex, with entry point `lib/db/serialized-connection.ts`.
- The second redemption starts only after the first commits; it is rejected by the conditional write carrying the old `shares` and `status: 'HOLDING'`, the entire transaction rolls back, and `CONFLICT` is thrown (`该持仓已发生变化，请重新确认。`).
- Different processes hold independent connections. SDK writes acquire SQLite write access before reading the business snapshot, and nested calls share the outer transaction.
- Cross-process consumption has covered original receipt replay, overdraft races, and category limit races; see `tests/integration/sdk-multiprocess-transaction.test.ts`.
- SQLite still has only a single writer. Sustained contention may reach lock waits or transaction timeouts; passing the consumption test cases does not prove usability under arbitrary load.
- The redemption test case `tests/unit/banking-sdk/atomicity.test.ts` checks one success, one `CONFLICT`, and that the account is credited only once; it does not cover cross-process redemption.

For code entry points, see [Wealth Management](../../banking-sdk/investment.ts), [Cards](../../banking-sdk/card.ts), and [Asset Summary](../../banking-sdk/dashboard.ts).
For exception handling, see [Own Transaction Confirmation](../../app/api/transactions/[id]/acknowledge/route.ts) and [Abnormal Transaction Card](../../components/chat/cards/AnomalyCard.tsx).

## Language and Desensitization Scope

The simulated model uses preset scripts and cannot represent the comprehension capabilities of an online model.
The online model declares the purpose and steps of the current round based on the conversation, and the server checks the structured plan and authorization.
Unrecognized natural language cannot be regarded as correctly understood financial instructions.

Credential redaction checks field names and defined text patterns.
Desensitization is not general sensitive-information detection; credentials in arbitrary free text may still be missed.
Real passwords or production credentials must not be entered in the demonstration environment.

For the rules, see [Current Round Intent](../../agent/intent-context.ts), [Plan Check](../../agent/tools/plan-compiler.ts), and [Log Desensitization](../../agent/durable/serialization.ts).

## Recovery Deployment Boundaries

The recovery handler process must be started independently:

```sh
pnpm agent:worker
```

It can also run 1 bounded check:

```sh
pnpm agent:recover
```

The web service does not implicitly start the recovery loop.
Model requests retain the original provider, endpoint, and input.
When the original model configuration or session version changes, the system stops resuming.
Before resending an incomplete model request, the system checks the original tool declarations.
When the tool declarations change, the system refuses to resend the original request.
Retry counts and backoff times are persisted; a process restart does not clear the count.

Operations with unknown results remain in a manual-check state.
When a receipt is corrupted or the ledger lacks execution evidence, the system does not reconstruct the historical execution format.
For the rules, see [Persistence and Recovery](agent-durability.md).

## Clocks and Data

Permissions, authentication, and execution leases use real time.
Business analysis uses an explicit UTC+08:00 demonstration date.
The scheduling command line can specify a trusted test time; public requests cannot set the clock.

The project supports only the current database model. `pnpm db:reset` rebuilds the simulated data.
Warning: preserve the data you need before resetting the database. The reset deletes existing simulated records.

For development and acceptance workflows, see [Development Guide](development.md) and [Testing Notes](test-cases.md).
