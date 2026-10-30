# Development Guide

**English** | [简体中文](../cn/development.md)

The project uses pnpm to manage dependencies and SQLite to store simulated data.
Development, testing, and builds are all run from the repository root.
For architectural responsibilities, see [Architecture Design](architecture.md).
For documentation terminology, see [Glossary](terms.md).

## First Startup

The runtime environment requirements are as follows:

| Item | Requirement |
| --- | --- |
| Node.js | 22.19.0 or later |
| pnpm | 12.3.4 |
| Browser | When running browser acceptance, a supported browser must be installed |

For version declarations, see [package.json](../../package.json).
Dependency changes require updating `pnpm-lock.yaml`.
Only commit `pnpm-lock.yaml`; do not introduce npm or Yarn lock files.

Execute the following commands in order:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).
The home page defaults to the AI assistant.
When the page opens, it goes directly into the shared conversation of a fixed demo user, with no login required.
Different browsers use the same session, and saved records are restored after a refresh.
`db:seed` loads simulated accounts, contacts, and business data.
Prisma Client must be generated before building. Business pages read data per request.

Warning: Running `db:seed` again will rebuild the demo user's business data.
If data must be preserved, stop the application and back up the database first.
For coverage, see [Seed Script](../../prisma/seed.ts).

## Interface Language

The interface supports Chinese and English, defaulting to Chinese on first open.
On desktop, switch languages at the bottom of the sidebar.
On mobile, switch languages at the top.
The selection is saved in the `banking_locale` cookie, valid for 1 years.
After refreshing the page and switching business pages, the selected language continues to be used.

[Language resources](../../lib/i18n/messages) are divided into 4 groups by responsibility:

| File prefix | Content |
| --- | --- |
| `app` | Navigation, layout, and general prompts |
| `chat` | Assistant, business cards, and charts |
| `business` | Business components, tasks, and run records |
| `pages` | Server-side business pages |

Each group contains `zh-CN` and `en`; the keys and parameters of both resources must match.
The client uses `useI18n()`, and the server uses `getServerI18n()`.
Full copy uses `{name}` parameter interpolation; amounts are passed as already precisely formatted text.
Unknown server-side states display the raw value.
Historical conversations, transaction facts, and user input retain the original text.

After switching languages, the client refreshes server components.
Conversation state is preserved, and banking operations are not resubmitted.
The root layout reads the language cookie, so pages render per request.
For the code entry point, see [lib/i18n](../../lib/i18n).

## Model Context Configuration

Full conversations are stored in the database.
When a model request exceeds the threshold, the system generates a summary and retains recent full turns.
Archive queries can recover the exact wording omitted from the summary.

| Environment variable | Default value | Unit |
| --- | --- | --- |
| `AGENT_COMPACTION_THRESHOLD_TOKENS` | `60000` | Estimated token count. |
| `AGENT_COMPACTION_RESERVE_TOKENS` | `8192` | Reserved token count. |
| `AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `12000` | Target token count for recent turns. |
| `AGENT_COMPACTION_SUMMARY_TOKENS` | `2048` | Upper limit for summary output tokens. |

A token is the unit of measurement for text processed by the model.
Configuration uses integers from `128` to `1000000`.
The actual threshold is also limited by the context capacity of the selected model.
After modification, restart the service so that subsequent model requests use the new configuration.
Existing model requests retain their original input when resumed.

The project directly calls the public `compact()` of Pi Coding Agent `1.2.0`.
The summary prompt, history serialization, and generation flow are handled by official functions.
The request preparation and context conversion hooks of Pi Core connect to the summary view.
The banking adapter layer continues to save full archives, compaction events, and checkpoints.
Recent messages are retained by complete user turns.
Summaries may omit details; `search_conversation_history` queries the full original text.
After summary generation fails, only read-only summary requests are retried.
Compaction does not authorize or rerun banking operations.
A single model request is still limited by model capacity.
Recent turns that exceed capacity retain the original text and report insufficient capacity.
For detailed rules, see [Context Compaction](context-compaction.md).

## Verification Directory

The development service uses `.next` by default.
The browser acceptance service uses `.next-e2e` to avoid overwriting the development cache.
While the development service is running, the production build can be output to a separate directory:

```sh
BANKING_NEXT_DIST_DIR=.next-build pnpm build
BANKING_NEXT_DIST_DIR=.next-build pnpm start
```

The build and startup must use the same directory.
Logs are written uniformly to `logs/`.

## Repeated Page Refreshes in Development

The development service synchronizes code versions through the hot update connection.
If the connection repeatedly reports `HMR hash mismatch`, the browser will continuously reload the page.
Version mismatches may come from an old development cache; cross-check with a new cache is needed.

1. Stop the development service using that cache directory.
2. Rename the default development cache `.next/dev` as a backup.
3. Run `pnpm dev` to regenerate the development cache.
4. Open the assistant page and confirm that input content is not lost due to a full page reload.

Only handle the development cache; do not reset the database, WeChat login, or business records.
When using `BANKING_NEXT_DIST_DIR`, handle the `dev` cache in the corresponding directory.
Do not move cache directories still in use by other services.

The project allows `localhost` and `127.0.0.1` to access development resources.
The latter is explicitly listed in `allowedDevOrigins` of `next.config.mjs`.
If the hot update connection is rejected when using only `127.0.0.1`, check that configuration first.
Closing the hot update connection cannot be used as the acceptance basis for page stability.

When using the web page and WeChat simultaneously, run `pnpm dev` and `pnpm weixin:start` separately.
The WeChat channel calls the banking HTTP interface, and the two processes share the banking service data.
For WeChat login and mobile send/receive checks, see [WeChat Channel](weixin.md).

## Hydration Warnings on the Initial Page

Hydration refers to React taking over the page generated by the server.
Browser extensions or integrations may add attributes to `<html>` before takeover.
For example, `data-redeviation-bs-uid` is not an attribute generated by the project.
When the server lacks the attribute but the browser side has it, a warning is triggered.

The root layout uses `suppressHydrationWarning` to tolerate this layer of difference.
Business components still retain hydration checks.
Language consistency is verified through acceptance checks of the Chinese default and Chinese-English switching.
Regression cases simulate external attribute injection before takeover.
For the cases, see [hydration.e2e-helper.ts](../../tests/e2e/hydration.e2e-helper.ts).

Next.js provides page rendering, navigation, HTTP routing, and cookie reading.
The banking SDK, permissions, and run persistence modules do not depend on Next.js.
Before removing the framework dependency, these Web entry points need to be replaced.

### Native Database Modules

The development service continues to use Next.js's default Turbopack.
[next.config.mjs](../../next.config.mjs) preserves Node.js loading for the following dependencies:

- `@prisma/client`.
- `@prisma/adapter-better-sqlite3`.
- `better-sqlite3`.

The SQLite adapter and native driver require correct module file locations.
Excluding only the Prisma client would still let the bundler process the adapter.
Native binding resolution may fail as a result, and the page cannot read the database.
The adapter must also be placed in `serverExternalPackages`.
This configuration is used for both the development service and production builds.

After modifying the native module loading configuration, stop and restart the development service.
Refreshing the browser alone will not replace already loaded server-side modules.
The acceptance service uses a separate `.next-e2e` and an isolated database.
If the startup process is interrupted, the acceptance process also cleans up the development service it created.
Daily development services and acceptance services use different output directories.

## Dependency Build Script Permissions

[pnpm-workspace.yaml](../../pnpm-workspace.yaml) stores build script permissions.
The value of `allowBuilds` must be `true` or `false`.
Placeholder text indicates it has not yet been decided and cannot be used as an approval result.
pnpm's strict build check rejects unreviewed dependency scripts.
For the rules, see [pnpm Build Settings](https://pnpm.io/settings/build#allowbuilds).

| Dependency | Approved | Reason |
| --- | --- | --- |
| `@prisma/engines` | `true` | Prepares the engine required by the CLI to synchronize the schema |
| `better-sqlite3` | `true` | Prepares the SQLite native driver |
| `prisma` | `true` | Checks the CLI runtime environment |
| `esbuild` | `true` | Prepares and validates platform binaries |
| `unrs-resolver` | `true` | Prepares the native binding used by the ESLint parser |
| `@google/genai` | `false` | The current install hook only prints no-op information |
| `protobufjs` | `false` | The install hook checks dependency version notation and does not generate runtime files |

When a dependency update introduces a new build script, read the script contents first.
Then update the permission table according to project needs.
If installation has completed but the script was previously skipped, execute the following command:

```sh
pnpm rebuild @prisma/engines better-sqlite3 esbuild prisma unrs-resolver
pnpm install --frozen-lockfile
```

## Dependency Responsibilities

All direct dependencies have code entry points and are retained by responsibility.
For the dependency list, see [package.json](../../package.json).

| Dependency | Purpose |
| --- | --- |
| `next`, `react`, `react-dom` | Pages, server routes, and interactive components |
| `@next/env` | Standalone scripts use Next.js environment loading rules |
| `@earendil-works/pi-agent-core` | Conversation and tool loop |
| `@earendil-works/pi-ai` | Model contracts, providers, and streaming responses |
| `@earendil-works/pi-coding-agent` | Reuses official context compaction through the public `compact()` |
| `@prisma/client` | Generates the runtime used by the client |
| `@prisma/adapter-better-sqlite3` | Adapter between Prisma and the SQLite native driver |
| `decimal.js` | Precise numeric arithmetic and settlement |
| `zod` | Validation of requests, tools, and run results |

`@next/env` uses the same version as Next.js.
Seed, database synchronization, and background workers import this package directly.
pnpm's dependency isolation requires declaring these direct imports.
Removing the declaration will cause standalone scripts to fail to find the module.

Pi's 3 direct dependencies are pinned to `1.2.0`.
The Coding Agent's `AgentSession.compact()` belongs to the coding session SDK.
The project uses the public low-level `compact()`, and session state continues to be stored in Prisma.
The project does not create a file session manager or start coding command-line sessions.
The banking tool registry does not register file, Shell, or coding tools.

The Coding Agent's npm package also includes command-line and terminal interface dependencies.
Transitive dependencies also include the Model Context Protocol (MCP) and the Photon image library.
The installation scope covers the entire npm package and cannot be estimated by a single compaction function.
After upgrading dependencies, verify official interfaces, archive retention, and crash recovery.
For the division of responsibilities and dependency costs, see [Context Compaction](context-compaction.md).

`@google/genai` is a transitive dependency of Pi AI.
The project does not directly call the Google SDK.
When using only DeepSeek, the SDK does not participate in model requests.
Prohibiting the package's install script is not the same as deleting its runtime files.
For details, see [Pi AI Dependency Declaration](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/package.json).

Consumption charts use React and native SVG.
The project has removed Recharts and its dedicated transitive dependencies.
Chart tooltips retain exact amount strings.
Axis labels and midpoints use precise numeric arithmetic.
Floating-point conversion is used only for chart coordinates.

Prisma CLI, TypeScript, and tsx are used for development and scripts.
ESLint, Vitest, and Playwright are used for code checks and acceptance.

## Dependency Versions and Upgrades

The current version verification date is `2026-10-29`.
The project pins verified dependency versions, and installation uses the lock file.
Subsequent upgrades require re-verifying interfaces and database transactions.

| Dependency | Pinned version |
| --- | --- |
| Pi Core, Pi AI, Pi Coding Agent | `1.2.0` |
| Next.js, environment loader, and Next.js ESLint plugin | `16.4.3` |
| React, React DOM | `19.3.0` |
| Prisma CLI, runtime, and SQLite adapter | `7.10.1` |
| TypeScript compiler | `7.0.2` |
| TypeScript program interface adapter package | `@typescript/typescript6@6.0.2` |
| Vitest | `5.0.4` |
| Tailwind CSS, PostCSS plugin | `4.3.3` |
| ESLint | `10.12.0` |
| Zod | `4.6.7` |

For complete versions, see [package.json](../../package.json).
For transitive dependency versions, see [pnpm-lock.yaml](../../pnpm-lock.yaml).
The RC of Prisma 8 is a pre-release version.
The project uses the stable version `7.10.1`.
For pinned replacement configuration of transitive dependencies, see [pnpm-workspace.yaml](../../pnpm-workspace.yaml).
When upgrading, check both that configuration and the lock file, and run `pnpm audit`.
Passing the audit only means that the vulnerability database at that time reported no hit known vulnerabilities.

TypeScript 7.0 provides the native compiler `tsc`.
That version does not yet provide a stable program interface.
Tools such as ESLint still require the program interface of TypeScript 6.
The project declares the 2 alias according to [Microsoft's parallel installation scheme](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

```json
{
  "@typescript/native": "npm:typescript@7.0.2",
  "typescript": "npm:@typescript/typescript6@6.0.2"
}
```

`pnpm typecheck` uses `tsc` of TypeScript 7.
Tools importing `typescript` obtain the official TypeScript 6 adapter package.
This arrangement separates compile checks from tool program interfaces.

`pnpm lint` runs ESLint directly.
Rules are stored in [eslint.config.mjs](../../eslint.config.mjs).
Next.js rules and React Hooks rules are enabled in that file.
Tailwind CSS uses the `@tailwindcss/postcss` plugin.
Global styles import `tailwindcss` directly.

After updating dependencies, execute the following commands in order:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Schema changes additionally require running `pnpm db:push`.
Ordinary dependency upgrades do not require rebuilding demo business data.
For Prisma 7 generation and driver rules, see [Database Management](#database-management).

## Model and Environment Configuration

Environment variables determine how the model runs.
The [configuration entry](../../lib/config.ts) reads configuration from the environment at call time.
The [model adapter](../../agent/providers) parses models and providers.
Variable templates are shown in [.env.example](../../.env.example).

Local configuration and secrets are stored in `.env.local`.
Next.js and the project command-line entry points load this file automatically.
Process environment variables take precedence over same-named values in the file.
Secrets must not be written into source code, logs, or documentation.

| Variable | Meaning and default value |
| --- | --- |
| `LLM_MODE` | `mock` uses the scripted model; `live` calls the model service. Defaults to `mock`. |
| `LLM_PROVIDER` | A provider identifier supported by Pi, or a custom provider. Default value is `openai`. |
| `LLM_MODEL` | The model identifier within the provider. Default value is `gpt-4o-mini`. |
| `LLM_REQUEST_TIMEOUT_MS` | Online request timeout. Defaults to 30000 milliseconds, range 1000 to 120000 milliseconds. |
| `DATABASE_URL` | SQLite database address. Uses `prisma/dev.db` when unset. |
| `DEMO_USER_ID` | Simulated user identifier. Default value is `user_liming`. |
| `BANKING_ALLOWED_ORIGINS` | Comma-separated full trusted addresses. When unset, only local addresses are allowed. |
| `MFA_MODE` | When unset or set to `demo`, simulated multi-factor authentication is used. Other values require an authentication adapter. |

A DeepSeek configuration example follows:

```dotenv
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

The online adapter first looks up the exact model identifier within the provider.
When the model identifier is not registered, the adapter reports an error and does not substitute another model.
To use an unregistered model, you must explicitly configure a service address compatible with the OpenAI interface.
The currently locked Pi registers `deepseek-flash`.
This model uses DeepSeek's own address.

Custom providers require an explicitly configured address.
The address is taken from `<PROVIDER>_BASE_URL`, then from `LLM_BASE_URL`.
The secret is taken from `<PROVIDER>_API_KEY`.
The address and authentication code are in [provider-live.ts](../../agent/providers/provider-live.ts).

Simulated multi-factor authentication uses verification code `123456` and does not send SMS.
For retry rules for model requests and financial commands, see [Persistence and Recovery](agent-durability.md).

## Trusted Access Addresses

Local development can use `localhost`, `127.0.0.1`, or `[::1]`.
When using other domains, set the full address in the server environment.
For example, with the public entry point `https://banking.example.com`:

```dotenv
BANKING_ALLOWED_ORIGINS=https://banking.example.com
```

Addresses include the protocol and non-default port, and do not include paths, query parameters, or fragments.
Separate multiple addresses with commas; after configuration, you must also explicitly list the local addresses you still want to use.
For example, to allow both the public entry point and local debugging:

```dotenv
BANKING_ALLOWED_ORIGINS=https://banking.example.com,http://localhost:3000
```

A reverse proxy must preserve the public entry point's `Host`.
HTTPS can be terminated at the proxy layer, and HTTP can be used between the proxy and the application.
When unknown domains are rejected, check the configuration and the proxy's Host forwarding.
The rejection rules cover pages, APIs, and static resources; see [Security Design](security.md#http-request-boundary) for details.
Trusted address configuration does not provide user login or role-based access control.

## Single-Turn Model Call Budget

Model requests from a single user input share the following limits.

| Environment Variable | Default Value | Meaning |
| --- | --- | --- |
| `AGENT_MAX_MODEL_REQUESTS` | `32` | Total number of model requests and actual HTTP retries |
| `AGENT_MAX_MODEL_TOKENS` | `2000000` | Cumulative reserved token count for input and maximum output |
| `AGENT_MAX_TURN_MS` | `300000` | Total duration in milliseconds starting from the first model call of the current turn |

Limits use positive integers; invalid configurations fall back to default values.
Summaries, reply repairs, and retries all count toward the total.
Token reservations are conservative upper bounds and differ from the provider's actual billed quantities.
Single-transmission timeout is still controlled by `LLM_REQUEST_TIMEOUT_MS`.
For rules on persistence, recovery, and tightening configuration, see [Single-Turn Model Call Budget](agent-durability.md#single-turn-model-call-budget).

## Database Management

[schema.prisma](../../prisma/schema.prisma) defines the current data structure.
The database commands are as follows:

| Command | Purpose |
| --- | --- |
| `pnpm db:generate` | Generate a Prisma Client matching the current schema. |
| `pnpm db:push` | Synchronize the current schema to the configured database. |
| `pnpm db:seed` | Rebuild the demo user's business data and load fixed products. |
| `pnpm db:reset` | Delete the configured database, then rebuild the table structure and initial simulated data. |
| `pnpm db:studio` | Open Prisma Studio to view records. |

### Generating the Client

`pnpm db:generate` executes `prisma generate`.
Prisma reads `prisma/schema.prisma`.
The generator uses `prisma-client` and outputs to `lib/db/generated`.
This directory is maintained by the generation command and is not committed to Git.
The public import entry point is [lib/db/prisma.ts](../../lib/db/prisma.ts).
Ordinary code imports model types and the runtime namespace from `@/lib/db/prisma`.
Standalone scripts use relative-path imports.
Business code queries and writes to the database through the client.
This command does not create tables or write business data.

In offline environments, the Prisma CLI checks for updates and the command may produce no output for a long time.
Before executing the Prisma CLI, set the following environment variables:

```sh
CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CI=1 pnpm db:generate
```

After setting each item in PowerShell, execute:

```powershell
$env:CHECKPOINT_DISABLE = '1'; $env:PRISMA_HIDE_UPDATE_MESSAGE = '1'; $env:CI = '1'; pnpm db:generate
```

The Prisma CLI reads [prisma.config.ts](../../prisma.config.ts).
This file declares the schema, database address, and seed command.
The schema declares only SQLite types; the address is provided by the configuration file.
The CLI and runtime share [url.ts](../../lib/db/url.ts).
Relative `file:` paths are based on the repository's `prisma/` directory.
Therefore, `file:./dev.db` points to `prisma/dev.db`.

The SQLite client uses a connection-level queue to isolate concurrent requests.
Ordinary queries wait until a transaction commits or rolls back.
Inside a transaction, you must use the passed-in transaction handle.
Switching to the global client will wait on the connection lock held by itself.
For isolation verification, see [database-adapter-isolation.test.ts](../../tests/integration/database-adapter-isolation.test.ts).

### Synchronizing the Table Structure

`pnpm db:push` executes [db-push.ts](../../scripts/db-push.ts).
The script loads the environment configuration, then calls `prisma db push`.
The script also pins the schema engine log level, so no manual setting is needed; see [prisma-cli-env.ts](../../lib/prisma-cli-env.ts).
The database address comes from `DATABASE_URL`.
The default SQLite database is `prisma/dev.db`.

Prisma creates or adjusts tables, fields, and constraints according to the schema.
When the database does not exist, Prisma creates it.
`db:push` does not generate migration history files.

Warning: Table structure changes may delete fields or data.
When a data loss prompt appears, first verify the changes and back up.
A normal sync does not populate simulated business records.

Prisma 7's `db push` no longer automatically generates the client.
After modifying the schema or generator, run `pnpm db:generate` separately.
Database synchronization and client generation are 2 independent steps.
For the rules, see [Prisma CLI Notes](https://docs.prisma.io/docs/cli/v7/db/push).

### Seeding Simulated Data

`pnpm db:seed` executes [seed.ts](../../prisma/seed.ts).
The script writes the demo user, accounts, contacts, and business records.
The script also writes fixed wealth management products.

Warning: Repeated execution deletes and rebuilds the demo user's business records.
The deletion scope includes accounts, transactions, holdings, cards, and contacts.
Subscriptions, budgets, and scheduled tasks are also rebuilt.
Fixed wealth management products are rebuilt with preset IDs.

The script attempts to write a `.backup.db` copy of the database.
Backup failures only log a warning, and seeding continues.
If you need to retain an operational record, stop the service first and back up yourself.

`db:seed` retains historical records such as conversations, runs, and execution receipts.
After business records are rebuilt, old conversations may still point to the original operations.
To re-experience from the initial state, use `db:reset`.

When creating an empty database for the first time, run `db:generate`, `db:push`, and `db:seed` in order according to "First Startup".
For daily startup, only `pnpm dev` is needed; no re-seeding is required.
After modifying the schema, synchronize the table structure and update the client.

### Re-experiencing from the Initial State

`pnpm db:reset` deletes the entire configured database.
It then rebuilds the current table structure and executes `db:seed`.
The deletion scope for old records is as follows:

- Conversations, model contexts, and unsubmitted business drafts.
- Pending confirmation operations, verification codes, and failure counts.
- Runs, model requests, tool calls, and event logs.
- Workflows, manual reviews, and execution receipts.
- Operation audits, security events, and business data.

After reset, the initial simulated accounts, balances, transactions, and scheduled tasks are restored.
"From the initial state" does not mean balances are 0 or that there are no sample transactions.
Browser settings for language and developer mode are retained.
`.env.local` and model secrets are also retained.

Warning: Save data you need to keep before resetting.
Without a usable backup, deleted records cannot be recovered.
The seed script's backup occurs after the database is rebuilt.
That backup cannot recover records from before the reset.

In the repository root, proceed as follows:

1. Stop `pnpm dev` or `pnpm start`.
2. Stop `pnpm agent:worker` and external scheduled scheduling.
3. Close Prisma Studio and other database connections.
4. Verify the `DATABASE_URL` used by the application.
5. Back up the database as needed; see below for the method.
6. Execute the reset command.

   ```sh
   pnpm db:reset
   ```

7. Start the application.

   ```sh
   pnpm dev
   ```

8. Refresh all open browser pages.

All processes must be stopped before resetting.
Old processes may hold connections or caches to deleted files.
Refreshing the page alone cannot replace restarting the process.

The database address comes from the process environment or `.env.local`.
When `DATABASE_URL` is unset, `prisma/dev.db` is used by default.
Relative paths start from `prisma/`.
For example, `file:./dev.db` points to `prisma/dev.db`.
Reset only allows SQLite files within the repository.
For the path check, see [db-push.ts](../../scripts/db-push.ts).

To explicitly select the default database, reset and startup use the same configuration:

```sh
DATABASE_URL=file:./dev.db pnpm db:reset
DATABASE_URL=file:./dev.db pnpm dev
```

Note: When a custom `DATABASE_URL` is set, reset acts on the custom database.
If the application is started with a different address, the page will continue to display data from the other database.

#### Backing Up the Default Database

After stopping all database connections, create a snapshot with the backup script:

```sh
node scripts/db-backup.mjs
```

The script writes the snapshot to `logs/db-backups/`.
The file name includes the time, a random identifier, and the source database file name.
After execution, the script prints the snapshot path and source database path.
The snapshot directory is created automatically if it does not exist, and the command can be run repeatedly.
Snapshots generated in the same second are each retained and do not overwrite older snapshots.
If the source database does not exist, the script prompts you to run `pnpm db:push` first and exits with a non-0 status.
Snapshots are stored under `logs/`, are ignored by `.gitignore`, and are not committed.
Snapshots use `node:sqlite`; configuration loading depends on the installed `@next/env`.
A `.json` file with the same name records the source database, snapshot path, and recovery instructions.

The script uses SQLite online backup, and the snapshot includes committed write-ahead log (WAL) data.
Copying only the main database file may miss commits in the WAL.

Backup and share backfill share `scripts/database-file.mjs`.
Configuration loading is consistent with Prisma commands and reads `.env.local`.
Explicitly exported `DATABASE_URL` takes precedence and does not print credentials.
When unset, the script uses `file:./dev.db`, i.e., `prisma/dev.db`.
When backing up a custom database, first export the same address used to start the application:

```sh
DATABASE_URL=file:./other.db node scripts/db-backup.mjs
```

Relative `file:` paths are based on `prisma/`.
After a successful backup, execute the reset.

#### Clearing Only Chat History

When you only need to restart the conversation, enable developer mode.
Then use "Clear Conversation" in the AI assistant.
This operation clears shared conversations, model contexts, and business drafts.
Business data, operation audits, run events, and execution receipts are retained.
Unfinished Agent work will prevent clearing.
Independent pending-verification operations on the card page are retained.
The scope of a full reset differs from clearing conversations.

After modifying the schema, generate the client first, then synchronize the database.
Only then can you start the application or build.
The project supports only the current schema and interface contracts.

Before modifying amount fields, read [Financial Values](financial-values.md).
Field names, units, and precision also constrain seed data and test data.

### Database Backup and Net-Value Share Upgrade

After wealth management holdings are recorded as "net value + shares", old databases need `shares` filled in.
Execute the following steps in order; the order cannot be swapped.

First back up the database; for the command and snapshot directory, see [Backing Up the Default Database](#backing-up-the-default-database):

```sh
node scripts/db-backup.mjs
```

Then synchronize the table structure:

```sh
pnpm db:push
```

Synchronization adds net value and share fields but does not derive shares.
`db push` does not generate the client; after code changes you still need to run `pnpm db:generate`.

When product net values or full numbers are missing, first prepare an explicit simulated data manifest.
An example is located at `scripts/fixtures/demo-reference.example.json`.
This file provides fictional demo values and is not data recovered from masked numbers.
Copy the example to `logs/`, and verify records, ownership, and expected display values one by one.
Unknown or changed records must not have the example applied directly.

```sh
pnpm exec tsx scripts/demo-reference-backfill.ts --plan=logs/reference.json --dry-run
pnpm exec tsx scripts/demo-reference-backfill.ts --plan=logs/reference.json --apply
```

By default it only previews; only `--apply` writes.
The manifest only fills empty values and does not overwrite existing net values or full numbers.
If ownership, name, product code, or display value does not match, the entire batch rolls back.
User records not listed in the manifest keep their original values, and account balances and transactions remain unchanged.

Old holdings derive shares from the latest net value:

```sh
node scripts/investment-share-backfill.mjs
```

By default it is a read-only dry run and does not write to the database.
The dry run prints a table with columns `holding`, `product`, `old market value`, `net value`, `shares`, `new market value`, `drift`, and `outcome`.
`outcome` for each row is `derived`, `derived (cost basis)`, or `skipped: <原因>`.
`derived (cost basis)` means `estimatedMarketValue` is empty, and market value falls back to the remaining holding cost.
There are only 2 skip reasons: `no-net-value` means the product has no net value or no matching product, and `net-value-not-positive` means the net value is 0.
When skipped rows exist, the exit code is `2`, indicating the upgrade is not yet complete.
Exit code `0` means there were no unresolved rows this time, and `1` means execution failed.
After the table, a summary row is printed, for example:

```text
[backfill] migrated: 2 (dry run)
[backfill] skipped (历史数据不足): 1
[backfill] total economic-value drift: 0.0000003265 CNY
[backfill] Re-run with --apply to persist the derived shares.
```

After verifying the results, write:

```sh
node scripts/investment-share-backfill.mjs --apply
```

The script accepts only `--apply` 1 parameter(s); other parameters cause an error.

The derivation basis is `shares = FLOOR(市值 ÷ 净值, 6 位小数)`, and market value uses the holding's `estimatedMarketValue`.
When `estimatedMarketValue` is empty, market value falls back to the remaining holding cost.
`--apply` writes `shares`, `estimatedMarketValue`, and `shares_estimated = 1` within a single transaction.
The market value written is the exact product of `shares × 净值`, and remains self-consistent with the shares.
Drift guard: if any single economic value change reaches `0.01 元`, the script skips writing for the entire round and exits with a non-0 status.
When the net value is negative, the script likewise aborts and keeps zero writes.

The derived shares are an estimate, not a subscription record.
The read side therefore reports `valueBasis: 'MIGRATED_ESTIMATE'`, and the page, cards, and WeChat label them "estimate."
Both the dry run and `--apply` state this marker.
For the net value, shares, and return conventions, see [Wealth Management Net Value, Shares, and Return Conventions](investments.md).

When a product has no net value, shares are not fabricated.
Such holdings remain as-is and are counted in the summary as `历史数据不足`.

The script only processes holdings where `status = 'HOLDING'` and `shares` is empty.
`REDEEMED` holdings and holdings that already have shares are not modified.
Repeated execution does not derive again; the migrated quantity is `0`.
The summary includes the migrated quantity, the skipped quantity, and the total economic value drift.

When a rollback is needed, restore using the following steps:

1. Stop all database connections.
2. Check the `source` in `.json` next to the snapshot to confirm the recovery target.
3. Save or delete the `-wal` of that target and the sidecar files of `-shm`.
4. Overwrite the target database with the snapshot.
5. Restore the matching code version and run `pnpm db:generate`.

Reason for deleting `-wal` and `-shm`: to avoid replaying old write-ahead logs.
The POSIX shell and PowerShell forms are equivalent; run only one of them.

POSIX shell:

```sh
rm -f prisma/dev.db-wal prisma/dev.db-shm
cp 'logs/db-backups/<时间戳>-dev.db' prisma/dev.db
pnpm db:generate
```

PowerShell:

```powershell
Remove-Item -Force -ErrorAction SilentlyContinue prisma/dev.db-wal, prisma/dev.db-shm
Copy-Item 'logs/db-backups/<时间戳>-dev.db' prisma/dev.db
pnpm db:generate
```

After recovery, run `pnpm db:seed` as needed, or start the application directly.

### Card settlement account binding backfill

When cards with unbound settlement accounts need to be backfilled, follow [Card Management](card-management.md#data-upgrade-and-rollback).
The backup, sync, backfill, and rollback commands are in that topic.

## Page entry points

| Path | Purpose |
| --- | --- |
| `/` | Redirects to the AI assistant by default. |
| `/agent` | Conversation; view results and workflow cards. |
| `/overview` | View the asset overview. |
| `/contacts` | Add, view, and delete contacts. |
| `/investments` | View wealth management products and current holdings. |
| `/manual` | In developer mode, demonstrate bank backend reconciliation and record reconciliation conclusions. |
| `/runs` | In developer mode, view run and tool invocation status, and request recovery. |
| `/schedules` | View scheduled tasks and reminders. |
| `/cards` | View cards; add or delete simulated cards after page confirmation and verification. |
| `/bills`, `/subscriptions` | View bills and subscriptions. |
| `/activity` | View user-facing operation records and business summaries. |
| `/audit` | In developer mode, view the full operation audit and tool details. |
| `/security` | View security events; developer mode can reset the failure count. |

HTTP requests use the fixed demo user configured on the server.
Confirmation, verification code, and recovery entry points initiated by the Agent are displayed in conversation cards.
Card add/delete uses the card page's independent confirmation and verification flow.
The Agent cannot add, request, or delete cards.
The contact save form and delete confirmation dialog represent the user's explicit confirmation.
Contact changes are committed in the same transaction as the operation audit.
The full phone number is used for payee lookup; pages and APIs return a masked phone number.
Client-side cookies and identity parameters cannot switch users or sessions.
There is currently no login system; the simulated identity is not equivalent to real bank authentication.
For identity and authorization rules, see [Security Design](security.md).

Desktop navigation is grouped by Assistant & Tasks, Banking, and Records & Security.
Mobile uses a closable side drawer.
Selecting a chat suggestion only fills in the draft; it does not send directly.
Enter sends the message; Shift + Enter inserts a newline.
When the input method confirms a candidate character, Enter does not send the message.
The input box adjusts with the available viewport height.
When the page opens, the shared conversation and pending confirmation actions are restored.
Normal use continuously saves the conversation; refreshing the page does not clear records.
The chat page initially reads the most recent 20 messages.
"Load earlier messages" adds 20 messages each time.
Display pagination does not trim the full conversation in the database.
Concurrent requests for the same conversation are protected by an execution lease.
When another page is executing, new requests are prompted with a conflict.

User input is displayed as plain text; assistant body text supports Markdown.
Tables, lists, quotes, code blocks, and links use a unified rendering component.
Raw HTML and remote images are not executed or automatically loaded.
Tool invocations are grouped by query, payment, card, wealth management, and task.
In-progress invocations show progress; completed ones show the recorded summary.
Only the current request's invocations are shown above the input box.
After confirmation, cancellation, or execution ends, the invocations in the original message update accordingly.
When the page refreshes, invocation status is restored from run records and operation records.
Executed cards no longer show "needs confirmation."
Raw tool names, invocation identifiers, and masked parameters are shown only in developer mode.
For card mapping and display rules, see [Conversation Business Cards](chat-presentation.md).

There is a "Developer Mode" toggle at the bottom of the sidebar, disabled by default.
When enabled, developer entry points such as "Run Records" and "Operation Audit" are shown.
The AI assistant also shows "Refresh Conversation" and "Clear Conversation."
The security center also shows a "Reset Failure Count" button.
The button requires no verification code and does not execute pending banking operations.
"Refresh Conversation" re-reads saved records and does not submit banking operations.
"Clear Conversation" requires confirmation and clears the shared conversation and model context.
Bank data, operation audit, run events, and execution credentials are still retained.
Pending confirmation, executing, pending reconciliation, or unfinished work blocks clearing.
Clearing and new requests use the same conversation write check, rejecting stale requests.
After clearing, old plans do not reappear in the chat due to browser cache.
Developer mode only controls demo tools and does not provide identity authentication.

### Historical message API

`GET /api/chat/history` returns the most recent 20 messages.
To continue reading, pass in the `nextCursor` from the previous response.
`limit` defaults to 20, allowing 1 to 20 messages.
The API returns messages in their original order; individual replies and cards remain intact.
`hasMore` indicates there are earlier messages.

The pagination identifier is bound to its user, conversation, and history version.
The message identifier determines the read position; timestamps do not serve for deduplication.
Appending new messages does not change the original pagination position.
A developer clearing the conversation changes the history version.
Pagination requests with an old version or a lost position return `409 CONFLICT`.
Malformed pagination requests return `400 VALIDATION`.
`revision` and `historyGeneration` in the response are used by the frontend to isolate stale responses.

The server reads the full conversation, then supplements authorization and workflow status.
The current conversation is still stored as JSON, and the server must parse the full archive.
Pages and APIs transmit only the messages of the selected page.
Pagination reads do not modify the original conversation or model messages.
For the code entry point, see [History Read Model](../../app/agent/history.ts).

`search_conversation_history` finds text from the original conversation archive.
This green query is scoped to the user and conversation that the run belongs to.
The query returns at most 20 user or assistant verbatim messages each time.
When `beforeIndex` is passed, only records before that position are read.
For the code entry point, see [Archive Query](../../agent/conversation-history-search.ts).
For the model request compression configuration, see [Context Compression](context-compaction.md).

A regular HTTP page may not have `crypto.randomUUID()`.
The frontend uses `crypto.getRandomValues()` to generate a request identifier.
The request identifier is only responsible for deduplicating run ingestion.
Authorization and idempotency keys for banking operations are still controlled by the server.

## Scheduled scheduling

The scheduling command checks for due tasks once per run:

```sh
pnpm scheduler:tick
```

Unattended operation requires a host scheduler to repeatedly execute the command.
The `/schedules` page can also initiate a check.
Due payments still require a new confirmation or multi-factor authentication.
For time override parameters, see [Scheduled Tasks](scheduled-tasks.md).

## Crash recovery process

The recovery command and the web service are started separately:

```sh
pnpm agent:recover
pnpm agent:worker
```

`agent:recover` performs one recovery check.
`agent:worker` runs continuously, checking once every 5 seconds by default.
It discovers at most 25 candidate runs each time.
The process manager needs to manage both the web service and the recovery process.

The interval and batch limit can be modified via parameters:

```sh
pnpm agent:worker --interval-ms 5000 --limit 25
```

The interval ranges from 250 to 60000 milliseconds.
The batch limit ranges from 1 to 100 runs.

| Situation | Recovery behavior |
| --- | --- |
| Original execution lease still valid | Wait for the lease to expire; do not take over execution. |
| Original model generation not finished | Regenerate according to the original request, respecting the persisted retry limit. |
| Independent workflow interrupted | Read the saved original graph and resume node execution. |
| Waiting for confirmation or multi-factor authentication | Preserve the original decision and wait for user action. |
| Financial write result cannot be proven | Escalate to manual reconciliation. |
| Workflow paused or waiting for manual handling | Preserve the control state. |

The execution lease for normal runs is 120 seconds.
The execution lease for independent workflows is 600 seconds.
Model continuation requires preserving the original provider and model configuration.
Independent workflow recovery does not invoke the model.
For details, see [Persistence and Recovery](agent-durability.md).

After receiving `SIGINT` or `SIGTERM`, the process stops accepting new recovery tasks.
The process waits for in-progress recovery tasks to finish.
After `SIGKILL`, subsequent processes wait for the lease to expire before taking over.

Check output contains only run identifiers, status, and error codes.
Concurrent execution conflicts are reported as `busy`.
Permanent checkpoint errors are reported as persisted terminal states.

## Verification and build

Run the standard checks in sequence:

```sh
pnpm test
pnpm lint
pnpm build
pnpm typecheck
```

Build and type checking require sequential execution.
The Next.js build rebuilds `.next/types`.
Type checking also reads this directory.

Vitest uses [tests/setup.ts](../../tests/setup.ts) to set up `prisma/test.db`.
Database tests share this file and reset the simulated data.
[vitest.config.ts](../../vitest.config.ts) disables test file parallelism.
Do not run multiple Vitest processes that use the database at the same time.
Test cases that drive a real conversation turn use `CHAT_DRIVEN_TEST_TIMEOUT_MS` from [tests/helpers/timeouts.ts](../../tests/helpers/timeouts.ts) as the 3 argument of `it(...)`.
Test cases that initialize a cold database from the command line pass `COLD_DB_PROVISION_TEST_TIMEOUT_MS`.
Both are shared constants; do not write bare numbers, and do not create separate copies in test cases.

The targeted test command is as follows:

```sh
pnpm exec vitest run tests/unit/financial-values.test.ts
pnpm test:watch
```

Browser acceptance testing is independent of Vitest:

```sh
LLM_MODE=mock pnpm exec tsx tests/e2e/acceptance.e2e.ts
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

Offline acceptance uses `prisma/e2e.db`.
Online acceptance uses `prisma/live-acceptance.db`.
The acceptance script prepares simulated data and starts the development server.
`E2E_BROWSER_PATH` can specify the browser executable.

The offline script explicitly sets `LLM_MODE=mock`.
The script also selects the `faux` provider and model.
After the service starts, the script queries `/api/health`.
Acceptance continues only if `data.llmMode` in the response is `mock`.
When the mode does not match, acceptance fails and stops.
The offline script name alone or service startup logs cannot prove the actual mode.
When running the demo service alone, you can also check `/api/health` to verify the mode.
The online script explicitly uses `live`; results should be recorded as online acceptance.

Note: when a browser is missing, test journeys may be skipped.
Check the `PASS`, `FAIL`, and `SKIP` counts in the results.
Online acceptance requires network and keys and incurs model request costs.
For test scope, see [Test Description](test-cases.md).

Verification processes need to run sequentially.
Running in parallel may contend over generated clients or build files.

Before starting in production mode, prepare the current database first, then run:

```sh
pnpm build
pnpm start
```

## Modification entry points

Use [Architecture Design](architecture.md) to find the responsibility modules.
When making changes, the following contracts must be maintained in sync:

| Change | What needs to be maintained |
| --- | --- |
| New tool | Tool catalog, parameter schema, executor, and registration entry; declare effects, authorization, and replay rules. |
| New financial write | Common command transaction, trusted execution context, required audit, and original execution receipt. |
| Modify workflow | Compile check, persisted ownership, and checkpoints; verify confirmation, pause, cancellation, and recovery. |
| Modify public response | API contract, route serialization, and frontend consumers. |
| Modify contract | Update the corresponding topic documentation and tests. |

The tool catalog is at [tool-catalog.ts](../../lib/contracts/tool-catalog.ts).
Tool executors and registration entry points are located in [agent/tools](../../agent/tools).
Financial writes need to verify duplicate requests, parameter conflicts, and transaction rollback.
For transaction rules, see [Persistence and Recovery](agent-durability.md).
For amount and budget rules, see [Financial Values and Settlement](financial-values.md).
Public financial inputs and outputs use decimal strings.
Frontend adapters check data according to the current response contract.

Temporary files, scripts, and logs are kept within the repository.
Code identifiers, new string literals, and code comments use English.

## File logging

Commands write output to the terminal by default.
When files need to be kept, save output to `logs/`.
For project rules on file log locations, see [Repository Context](../../CONTEXT.md).

Create the directory first, then execute the command that needs to be logged:

```sh
mkdir -p logs
pnpm test > logs/tests.log 2>&1
pnpm build > logs/build.log 2>&1
```

`>` saves standard output; `2>&1` merges error output.
This form overwrites logs with the same name.
To append records, replace `>` with `>>`.

Logs may contain request and error information and are not committed to Git.
`.gitignore` already ignores `logs/` and `.log` files.
Business audit, events, and execution receipts are still saved in the database.
