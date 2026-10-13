# Development guide

## Prerequisites and first run

Use Node.js 22.19 or later and pnpm 12.3.4, as declared in [`package.json`](../package.json). Dependency changes must update `pnpm-lock.yaml`; do not introduce npm or Yarn lockfiles.

Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

Open [http://localhost:3000/agent](http://localhost:3000/agent). This sequence generates Prisma Client, creates the current schema and loads the simulated dataset. A seeded database is also needed before the production build because some pages query data during prerendering.

## Model configuration

Configuration is read by [`lib/config.ts`](../lib/config.ts) and resolved by [`agent/providers/`](../agent/providers/). The checked-in [`.env.example`](../.env.example) lists the common variables. Store local overrides and real API keys in `.env.local`; Next.js and the project CLI environment loaders load them. Existing process environment variables take precedence over file values.

| Variable | Behavior |
| --- | --- |
| `LLM_MODE` | `mock` uses the scripted provider without network calls; `live` calls the configured provider |
| `LLM_PROVIDER` | Provider ID understood by Pi, or an explicitly configured custom provider |
| `LLM_MODEL` | Model ID resolved within that provider |
| `LLM_REQUEST_TIMEOUT_MS` | Live request deadline; defaults to `30000`, valid range `1000` through `120000` |
| `DATABASE_URL` | SQLite URL; the application falls back to `prisma/dev.db` when unset |
| `DEMO_USER_ID` | Simulator actor; defaults to `user_liming` |
| `MFA_MODE` | Unset or `demo` selects simulated verification; other values require an implemented adapter |

For DeepSeek live mode, set these values in `.env.local` and supply your own key:

```dotenv
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
DEEPSEEK_API_KEY=<your-api-key>
```

The live resolver first looks for the exact model in the installed Pi registry. If the provider exists but the requested model does not, it selects that provider's registered default and emits a warning. An unregistered provider requires `<PROVIDER>_BASE_URL` or `LLM_BASE_URL`, and authenticates using `<PROVIDER>_API_KEY`; the resolver does not guess a different provider's endpoint. See [`provider-live.ts`](../agent/providers/provider-live.ts).

The current MFA adapter uses `123456` and sends no SMS. Provider HTTP retries and banking command retries have different rules; see [agent durability](agent-durability.md) before changing either policy.

## Database lifecycle

[`prisma/schema.prisma`](../prisma/schema.prisma) defines the current persisted model. The project supports the current schema and API contracts only; it has no old database conversion procedure.

| Command | Use |
| --- | --- |
| `pnpm db:generate` | Regenerate Prisma Client after a schema or dependency change |
| `pnpm db:push` | Synchronize the configured database with the current schema |
| `pnpm db:seed` | Load the current simulated dataset |
| `pnpm db:reset` | Recreate the configured demo database, then seed it |
| `pnpm db:studio` | Inspect records with Prisma Studio |

Stop the application before `pnpm db:reset`. This explicit reset deletes the workspace-local database and its SQLite WAL, SHM and journal sidecars. Ordinary `db:push` does not run that reset. The implementation and path checks live in [`scripts/db-push.ts`](../scripts/db-push.ts).

After changing the schema, regenerate the client and synchronize a current database before running the application or build. Use `db:reset` when you want to discard the simulated dataset and start fresh.

Financial field names and units are part of the schema contract. Consult [financial values](financial-values.md) before changing fields, DTOs, seed data or fixtures.

## Application entry points

| Page | Purpose |
| --- | --- |
| `/` | Asset overview |
| `/agent` | Natural-language chat, results and workflow cards |
| `/actions` | Pending confirmation, verification and evidence recovery |
| `/manual` | Operator notes and workflow handoff |
| `/runs` | Persisted run and invocation states with explicit recovery controls |
| `/schedules` | Scheduled intents and delivered reminders |
| `/bills`, `/cards`, `/subscriptions` | Banking read models and management screens |
| `/audit`, `/security` | Owned audit records, incidents and demo unlock controls |

HTTP identity comes from the application session cookie. The simulator's demo actor is not a real bank identity integration. See [security](security.md) for the server-enforced ownership and authorization rules.

## Scheduler operation

The scheduler is a bounded command, not a resident worker:

```sh
pnpm scheduler:tick
```

A process manager or host scheduler must invoke it repeatedly for unattended dispatch. The `/schedules` page can also request a check. Due payments reach fresh confirmation or MFA; a worker does not approve them. Time overrides for trusted demonstrations and dispatch details are documented in [scheduled tasks](scheduled-tasks.md).

## Validation

Run the standard checks from the repository root:

```sh
pnpm test
pnpm lint
pnpm build
pnpm typecheck
```

Run the build and typecheck sequentially: Next.js regenerates `.next/types` during a build, and `tsconfig.json` includes those generated files.

Vitest uses [`tests/setup.ts`](../tests/setup.ts) to provision an isolated `prisma/test.db` and select mock mode. Database-backed suites reset and seed this shared file. [`vitest.config.ts`](../vitest.config.ts) disables file parallelism; do not run separate database-backed Vitest processes concurrently.

For a focused check or watch session:

```sh
pnpm exec vitest run tests/unit/financial-values.test.ts
pnpm test:watch
```

The real-browser harnesses run separately from Vitest:

```sh
pnpm exec tsx tests/e2e/acceptance.e2e.ts
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

The offline browser harness uses `prisma/e2e.db`; live acceptance uses `prisma/live-acceptance.db` and the configured model credentials. Both provision their own datasets and start a development server. They need an installed supported browser; `E2E_BROWSER_PATH` can select its executable. A missing browser can produce skipped journeys, so inspect the PASS/FAIL/SKIP summary. Live acceptance also needs network access and makes provider requests. Run validation processes one at a time to avoid shared generated-client or build artifacts racing. See [test coverage](test-cases.md) for the layers and scenario entry points.

For production serving, initialize the current database first, then run:

```sh
pnpm build
pnpm start
```

## Changing the implementation

Use [architecture](architecture.md) to select the owning module before editing. Keep the following changes aligned:

- A new tool needs a catalog entry in [`lib/contracts/tool-catalog.ts`](../lib/contracts/tool-catalog.ts), schemas and a runner in [`agent/tools/`](../agent/tools/), and registration in [`agent/tools/index.ts`](../agent/tools/index.ts). Declare its effect, authorization and replay policy explicitly.
- A write needs the common command boundary, trusted execution context, required audit and a complete original receipt. Verify duplicate requests, conflicting arguments and rollback behavior. Read [money and budget boundaries](money-budget-boundaries.md) and [agent durability](agent-durability.md).
- A workflow change needs compiler validation, persisted ownership and checkpoint behavior. Exercise confirmation, pause, cancellation and recovery through the relevant scenario or HTTP tests.
- A public response change needs matching contracts, route serialization and frontend consumers. Financial inputs and outputs are decimal strings; frontend adapters validate the current response shape.
- A contract change needs its current topic guide updated. Historical reports retain their original scope and do not define current behavior.

Keep temporary logs, scripts and other working artifacts inside the repository. Code identifiers, new string literals and comments must be English. Do not put credentials into source files, logs or documentation.
