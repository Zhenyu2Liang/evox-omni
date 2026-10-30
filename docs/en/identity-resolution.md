# Phone Number and Card Identity Resolution

**English** | [简体中文](../cn/identity-resolution.md)

Identity determination and candidate filtering are two different sets of rules.
Identity determination only recognizes complete numbers or exact ids, and the result can be bound to a payee or a card.
Masked values and numeric fragments are only used to narrow candidates, and the caller must then require the candidate to be unique.
Resolution is completed on the server side during the park phase, and after success the parameters are normalized to a unique id.
For amounts and settlement rules, see [Financial Values and Settlement](financial-values.md).
For card addition/removal and settlement account binding, see [Card Management](card-management.md).

## Identity Determination and Candidate Filtering

Identity determination is the only rule that can bind a payee or a card; candidate filtering only narrows the list.
The two questions are answered by different functions and must not be substituted for each other.
After obtaining candidates, the caller must then require the candidate to be unique.

| Question | Function | Allowed input | Result use |
| --- | --- | --- | --- |
| Is this input exactly this contact | `phoneIdentityMatches` | Complete 11-digit mobile number | Can bind payee and transfer |
| Is this contact possibly the one the user means | `phoneCandidateMatches` | Complete number, masked number, 1 to 11-digit numeric fragment | Only narrows candidates; uniqueness must then be confirmed |
| Does the search term hit the contact's display value | `searchPhoneMatch` | Same as above | Only returns search candidates; never determines identity |

Identity determination is performed according to the following rules:

- The complete number entered must be character-for-character equal to `Contact.phoneFull`.
- The middle four digits participate in the comparison, so numbers that only share the same visible ends cannot pass identity determination.
- For historical rows where `phoneFull` is empty, identity is considered the same only when the `Contact.phone` display column itself holds the same complete number.
- When the display column has only a masked value, that row has no complete number, and a complete-number input returns `false`.
- Masked numbers and numeric fragments always return `false`.

Candidate filtering is performed according to the following rules:

- For complete numbers, compare character-for-character against complete records; for records with only masked values remaining, compare the visible ends using the first three and last four digits.
- Masked numbers narrow candidates by the first three and last four digits.
- Numeric fragments match by substring after removing mask characters.
- Candidate filtering results cannot be used directly as execution targets.

`searchPhoneMatch` only compares the display value passed in, so it can never see `Contact.phoneFull`.
Contact search uses `contactPhoneFacets` to assemble candidates, and complete-number queries can hit `phoneFull`.

Note: `maskAwarePhoneMatch` preserves strict identity semantics and only compares two numbers of the same form.
This function is not used to build search lists.

Determination locations are as follows:

- [Payee Resolution](../../security/recipient-resolution.ts) first performs identity determination, then uses masked candidates for uniqueness.
- `resolveRecipient` in [Transfer Execution](../../banking-sdk/transfer.ts) independently re-resolves the payee at execution time.
- [Add Contact](../../banking-sdk/contact.ts) uses identity determination to reject duplicate mobile numbers.
- `searchContacts` in [Contact Query](../../lib/db/repositories/contact.ts) only uses candidate filtering.
- [Number Semantics](../../lib/phone.ts) is the sole source of identity determination and candidate filtering.

`resolveRecipient` on the execution side follows the same rules as the park phase.
The execution side accepts only 1 of `contactId`, `phone`, `name`; receiving any other count returns `VALIDATION`.
`phone` first performs identity determination, and when there is no hit and the value is masked, it then narrows by candidates.
0 candidate returns `NOT_FOUND`; multiple candidates return `CONFLICT`, and `detail.candidates` provides a masked contact view.
`name` is first narrowed via `searchContacts`, then requires exact name equality.

## Cross-User Isolation

Resolution only reads the caller's own data.
Contact resolution iterates only over the caller's own contacts, and card resolution iterates only over the caller's own cards.
Ids belonging to other users or nonexistent ids resolve to `not_found`, without stating the specific reason.
Candidate lists include only the caller's own records and are returned in masked form.
The execution side independently rechecks ownership: contacts belonging to other users return the same `NOT_FOUND` as nonexistent contacts.
Cards belonging to other users return `SECURITY_DENIED`.

## Server-Side Resolution and Parameter Normalization

Write operations resolve the operation target during the park phase, before confirmation card generation and execution.
Resolution results have 4 states:

| State | Meaning | Follow-up action |
| --- | --- | --- |
| `resolved` | Exactly 1 object | Parameters normalized and written to pending confirmation operation |
| `not_found` | No object matches | Return clarification; do not write pending confirmation operation |
| `ambiguous` | Multiple objects match | Return clarification and list masked candidates |
| `invalid` | Selector missing or shape unusable | Return clarification and explain the reason |

Payee resolution is determined in two steps:

1. First use identity determination to match all provided selectors.
2. When identity has no hit and at least 1 of the `phone` selectors are masked values, then use candidate filtering to narrow the caller's own contacts.

Candidate narrowing has only 3 outcomes:

- 0 candidate returns `not_found`.
- 1 candidate is made unique, with state `resolved`; this is candidate uniqueness, not number equality.
- Multiple candidates return `ambiguous`, and the candidate list gives only masked names and masked numbers.

When there is only a complete number or numeric fragment and no masked `phone` selector, an identity miss is directly `not_found` and does not enter candidate narrowing.
Numeric fragments are never resolved as a payee.

On successful resolution, parameter normalization is performed:

- After payee resolution, write `contactId` and delete `phone` and `name`.
- After card resolution, write `cardId` and delete `cardType`, `cardTail`, and `cardNumber`.
- Other parameters (amount, category, merchant, reason) retain their original values.
- The confirmation card and SDK execution use the same id, and the two will not point to different objects.

Note: A clarification request does not create `PendingAction` and does not initiate multi-factor authentication.
Based on this, the model asks the user a follow-up question and submits the unique object in the next turn.

The resolution entry point is `gatewayCreatePendingAction` in the [Permission Gateway](../../security/security-gateway.ts).
There is also a fallback layer on the tool runner side: when only selectors are present, obtain the id through the same resolver; if resolution fails, return `VALIDATION` with the same masked clarification.

## Card Selectors

Card write tools accept 4 optional selectors, all optional and combinable.
Every provided selector must hit the same card.

| Selector | Accepted format | Match basis | Rejection case |
| --- | --- | --- | --- |
| `cardId` | Exact id returned by `get_cards` | Exactly equal to the caller's own card id | Writing a last-four or card number into this field returns `invalid` |
| `cardType` | `DEBIT`, `CREDIT`, `VIRTUAL`; debit card, savings card, credit card, virtual card | Card type, case-insensitive | Unrecognized type returns `invalid` |
| `cardTail` | `6688`, `尾号6688`, `****6688`, `...6688` | Last 4 digits of `numberMasked` or `numberFull` | Failure to extract exactly 4 digits returns `invalid` |
| `cardNumber` | 12 to 19 digits, may be separated by spaces or hyphens | Exactly equal to `Card.numberFull` | Shape mismatch returns `invalid` |

Rejection rules are as follows:

- When there is no selector at all, return `invalid`.
- When a last-four or complete card number is placed into `cardId`, return `invalid`; the error text is provided by `CARD_ID_SHAPE_REFUSAL`.
- A last-four placed in the wrong field will not degrade into a last-four query, nor will it hit other cards.
- Multiple candidates return `ambiguous`; the clarification message lists candidates by type and masked last-four, for example `借记卡 ****6688`.
- Complete card numbers are compared exactly only with `numberFull`; cards where this column is empty cannot be selected with `cardNumber`.
- Historical rows where `numberFull` is empty are selected with `cardId`, `cardType`, or `cardTail`.

Cards newly created at runtime all carry a server-generated complete card number.
The following 3 card creation paths all write `Card.numberFull`:

- Virtual card application: `applyVirtualCard`.
- Replacement card reissue: `replaceCard`.
- Page-added card record: `addDemoCard`.

Therefore `cardNumber` is also available for newly created cards.
The complete card number is an 16-digit fictitious number: `6222` plus 8 `0` plus the trailing 4 digits, in a form like `6222000000001234`.
The trailing 4 digits are unique within the caller's own cards, and the complete card number is therefore unique.
`Card.numberMasked` is derived by the [Masking Module](../../lib/mask.ts) from the last 8 digits of the same complete card number, in a form like `****1234`, and the two are always consistent.
Complete card numbers still do not enter any external output; for the boundary, see [Storage and Masking Boundary for Complete Numbers](#storage-and-masking-boundary-for-complete-numbers).

The tools that use selectors are the following 6 write tools; the set is in `CARD_TARGET_TOOLS`:

- `set_card_limit`
- `freeze_card`
- `unfreeze_card`
- `consume_virtual_card`
- `report_lost_card`
- `replace_card`

`get_cards` only queries cards and does not accept selectors.
`apply_virtual_card` creates a new card and does not accept selectors.

Selector parameters are defined in `cardSelectorFields` of [Card Tools](../../agent/tools/card.ts).
For the resolution code, see [Card Selector Resolution](../../security/card-resolution.ts).

## Fictitious Test Data Number Ranges

Demo data and test fixtures use only fictitious numbers.
The middle four digits of mobile numbers are fixed as `0000`, in a form like `1XX000000NN`.
Card numbers consist of `6222`, all `0`, and the original trailing 4 digits, in a form like `6222000000006688`.

| Record | Complete value (server-side only) | Display value |
| --- | --- | --- |
| Contact | `13900000002` | `139****0002` |
| Card | `6222000000006688` | `****6688` |

[Demo Seeds](../../prisma/seed.ts) and [Test Fixtures](../../tests/helpers/fixtures.ts) have noted that these numbers are fictitious data.
Warning: Do not use real personal mobile numbers or real bank card numbers to populate demo data, fixtures, or tests.

## Storage and Masking Boundary for Complete Numbers

There are only 2 dedicated server-side columns for complete numbers:

- `Contact.phoneFull`: complete fictitious mobile number, may be empty.
- `Card.numberFull`: complete fictitious card number, may be empty.

The display columns are `Contact.phone` and `Card.numberMasked`.
On historical rows or contacts added via HTTP interfaces, these two may still hold complete numbers.
In all other cases they hold only masked values; for migration, see [Data Upgrade and Rollback](#data-upgrade-and-rollback).
Server-side exact matching preferentially reads the dedicated complete-number columns.
The following locations output only masked values:

- Logs.
- Tool results and model-visible text.
- Interface responses, including `ContactView` and `CardView`.
- Error messages and session events.
- Clarification messages: 12 to 19-digit numbers in the text are first masked via `maskCardReferences`.

Pending confirmation operations store only the normalized `contactId` or `cardId`.
Execution receipts store only the request summary and result; neither stores the original number selector.

Masking code is centralized in the [Masking Module](../../lib/mask.ts), providing `maskPhone`, `maskAccountNumber`, and `maskCardNumber`.
Layers must not write their own masking code, nor copy this code.

Note: A masked display value cannot be restored to the complete number; the middle four digits and leading digits do not appear in any external output.

## Data Upgrade and Rollback

The upgrade only adds 2 nullable columns, and existing data remains readable.
Rows not backfilled remain empty; such contacts can only be selected by id, name, or masked number, and cards only by id, type, or last-four.

### Upgrade Steps

1. Stop the application and restore process.
2. Create a database snapshot according to the [backup steps in the Development Guide](development.md#backing-up-the-default-database).
3. Sync the schema and generated client.

   ```sh
   pnpm db:push
   pnpm db:generate
   ```

4. Write the demo seed rows.

   ```sh
   pnpm db:seed
   ```

   Note: The seed script only affects the demo records it writes itself.

5. Rehearse the backfill plan without writing data.

   ```sh
   pnpm exec tsx scripts/number-backfill.ts --dry-run
   ```

6. Write the backfill results.

   ```sh
   pnpm exec tsx scripts/number-backfill.ts
   ```

7. Check the report and change list.

   The list is saved in `logs/number-backfill/<时间戳>-applied.json`.

Warning: Skipping the database backup will lose committed contact and card records.

### Backfill Rules

The [backfill script](../../scripts/number-backfill.ts) processes data according to the following rules:

- Only scan rows where `phoneFull` or `numberFull` is empty.
- The only permitted backfill is copying from the display column.
  When the display column is already a complete number, copy it into the complete-number column and normalize the display column to masked form.
- Masked display values are never restored; missing digits are not guessed or inferred.
- Writes use compare-and-swap: the complete-number column is still empty, and the display column has not been changed.
- User-added records with values are outside the scan scope, and the script will not overwrite these records.
- Repeated execution is idempotent: a second run backfills no records.

### Records That Cannot Be Backfilled

Masked records can be completed via an explicit mock data list.
For the operation method, see [Upgrade Steps](development.md#database-backup-and-net-value-share-upgrade).
The list must specify record ownership, expected display value, and complete test number.
This is configuring new test data, not restoring missing digits.

The report lists record id, masked value, and reason item by item.

| Reason | Meaning |
| --- | --- |
| `unrecoverable-masked` | Display column has only a masked value; missing digits cannot be restored |
| `unrecognized-format` | Display column is neither a complete number nor in masked form |
| `already-complete` | Another write has already backfilled the row first |
| `display-changed` | Display column changed after scanning |

### Rollback Steps

Only values written by this script need to be rolled back.
The added columns are compatible changes and can be retained.

1. Stop the application and database connections.
2. Execute the rollback command.

   ```sh
   pnpm exec tsx scripts/number-backfill.ts --rollback=logs/number-backfill/<时间戳>-applied.json
   ```

3. When earlier data needs to be restored, overwrite the database with the snapshot.

Rollback only clears rows that still hold values written by the script; rows manually modified remain unchanged.
Desensitization normalization of display columns is not rolled back; that operation only reduces exposure.
`--dry-run` cannot be used together with `--rollback`.

## Code entry points

- [Number semantics](../../lib/phone.ts): identity determination, candidate filtering, and fragment search.
- [Masking module](../../lib/mask.ts): the single source of masking for phone numbers, account numbers, and card numbers.
- [Payee parsing](../../security/recipient-resolution.ts): parses transfer payees and normalizes `contactId`.
- [Transfer execution](../../banking-sdk/transfer.ts): the execution side re-parses payees according to the same rules.
- [Card selector parsing](../../security/card-resolution.ts): parses card selectors and normalizes `cardId`.
- [Permission gateway](../../security/security-gateway.ts): the park stage calls the parser and returns clarification or normalized parameters.
- [Card tool](../../agent/tools/card.ts): selector parameter definitions and runner-side fallback parsing.
- [Contact repository](../../lib/db/repositories/contact.ts): `contactPhoneFacets` and candidate queries.
- [Database schema](../../prisma/schema.prisma): `phoneFull` and `numberFull` columns.
- [Backfill script](../../scripts/number-backfill.ts): backfill, dry-run, and rollback commands.
- [Unit tests](../../tests/unit/lib/phone-identity.test.ts): boundary cases for identity determination and candidate filtering.
- [Backfill script tests](../../tests/unit/scripts/number-backfill.test.ts): idempotency, skip reasons, and rollback.

For test scope and evidence rules, see [Test description](test-cases.md).
For the role of matching rules in business decisions, see [String matching review](string-matching-review.md).
For permissions, confirmation, and auditing, see [Security design](security.md).
