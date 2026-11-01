<h1 align="center">
  <a href="https://github.com/Zhenyu2Liang/evox-omni">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/evox_brand_light.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/images/evox_brand_dark.svg">
      <img src="docs/images/evox_brand_dark.svg" alt="EvoX Logo" width="420" height="140">
    </picture>
  </a>
</h1>

<h2 align="center">EvoX Omni · 万象柜坊</h2>

<p align="center"><strong>English</strong> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">A natural-language AI agent for simulated banking, available on the web and through WeChat.</p>

<div align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge" alt="Apache-2.0 License">
  </a>
  <a href="docs/en/README.md">
    <img src="https://img.shields.io/badge/docs-Documentation-2E8B57?style=for-the-badge&amp;logo=readthedocs" alt="Developer documentation">
  </a>
  <a href="https://github.com/Zhenyu2Liang/evox-omni/issues">
    <img src="https://img.shields.io/badge/GitHub-Issues-5865F2?style=for-the-badge&amp;logo=github" alt="Issues">
  </a>
</div>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#model-configuration">Model Configuration</a> ·
  <a href="#wechat-integration">WeChat</a> ·
  <a href="docs/en/README.md">Documentation</a>
</p>

Query balances, analyze spending, initiate transfers, and manage cards through natural-language requests.
Operations are authorized by server-side code and recorded with execution receipts.

This project is intended for learning, research, and workflow demonstrations. It is not connected to real banking or payment services.
Accounts, transactions, and verification are simulated.
The application uses a fixed demo user without login; browsers share the same account and saved conversation.
Production user authentication, role-based access control, and real identity verification are not provided.

## Features

| Area | Capabilities |
| --- | --- |
| Natural-language interaction | Streaming web chat, WeChat text conversations, business cards, and explicit confirmations |
| Accounts and transfers | Balances, transaction history, contacts, and transfers by contact name or phone number |
| Spending analysis | Categories, trends, suspicious transactions, and explanations of triggered rules |
| Monthly and annual reports | Report pages, on-demand model analysis, and PDF, HTML, and CSV exports |
| Cards and subscriptions | Card status, spending limits, freezing and loss reporting, virtual cards, and subscription management |
| Investments | Product comparisons, holdings and net asset values, purchases, and redemptions by shares or amount |
| Multistep and scheduled tasks | Sequential and conditional execution, pause and resume, reminders, and confirmation of due payments |
| Execution and recovery | Audit records, idempotent execution receipts, persisted events, and recovery after interruptions |

The interface supports Chinese and English, with light, dark, and system appearance settings.
Conversations are saved with paginated history. Full archives remain available after model context compaction.
See the [implemented features guide](docs/en/implemented-features.md) for entry points and simulation boundaries.

## Quick Start

### 1. Prerequisites

| Tool | Requirement |
| --- | --- |
| Node.js | `>=22.19.0` |
| pnpm | `12.3.4` |
| Git | Required to clone the repository |

Version requirements are declared in [package.json](package.json).
To install the specified pnpm version, run `npm install --global pnpm@12.3.4`.

```sh
git clone https://github.com/Zhenyu2Liang/evox-omni.git
cd evox-omni
pnpm install --frozen-lockfile
```

### 2. Configure the local demo

Create `.env.local` in the repository root. The quick start uses `live` mode with your own API key; this example uses DeepSeek:

```dotenv
DATABASE_URL=file:./dev.db
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

This configuration stores data in `prisma/dev.db`.
Replace `<your-api-key>` with your own DeepSeek API key before starting. `live` mode requires network access and may incur model service charges.
For an offline demo, set `LLM_MODE=mock`. This uses a scripted model with limited natural-language coverage and requires no API key or external model requests.
See [.env.example](.env.example) for the full configuration template.

### 3. Initialize and start

Run the following commands to create the demo database for the first time:

```sh
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to access the assistant.
An introductory guide appears on the first visit and can be reopened from the page's help control.

**Data reset:** Running `pnpm db:seed` again rebuilds the demo user's data.
`pnpm db:reset` deletes the selected database and initializes it again. Stop the application and [back up the database](docs/en/development.md#backing-up-the-default-database) first if its data must be retained.

### 4. Try the demo

Try these English prompts in `live` mode. The seeded contact `妈妈` means “Mom”.

| Intent | Sample prompt |
| --- | --- |
| Query account balances | Show my account balances. |
| Analyze September 2026 spending | Analyze my spending for September 2026. |
| Explain suspicious transactions | Check for suspicious transactions and explain which rules each one triggered. |
| Transfer CNY 300 to Mom with a taxi remark | Transfer CNY 300 to the contact “妈妈” with the remark “Taxi”. |
| Schedule a CNY 300 transfer to Mom for 3 PM tomorrow | Schedule a transfer of CNY 300 to the contact “妈妈” for tomorrow at 3 PM Beijing time. |

When confirmation or verification is required, review the recipient, amount, card, and execution time before continuing.
The demo verification code is `123456`; no real SMS is sent.
View and export monthly or annual reports from the [bill reports page](http://localhost:3000/bills/reports).
Report analysis is generated only when requested. In `live` mode, it calls the configured model service.

## Model Configuration

To switch providers, update the provider, exact model identifier, and API key in `.env.local`, then restart the banking service.
See [model and environment configuration](docs/en/development.md#model-and-environment-configuration) for other providers, compatible endpoints, and request budgets.
Keep keys in local configuration; never commit them or include them in issues or runtime logs.

## WeChat Integration

Start the banking web service first, then run these commands in another terminal:

```sh
pnpm weixin:login
pnpm weixin:start
```

Scan the QR code in WeChat and complete account binding to send requests through a text conversation.
WeChat and the web interface share the same banking service and demo data.
Command keywords use Chinese, as shown below:

| Command | Purpose |
| --- | --- |
| `/帮助` | Show supported requests and commands |
| `/待办` | Show the current operation and remaining queue length |
| `/确认` | Confirm the currently displayed operation |
| `/验证 123456` | Submit the demo verification code for the current confirmed operation |
| `/取消` | Cancel the currently displayed operation |

Queued operations are shown one at a time and confirmed separately. An operation requiring verification stays active until verification is completed.
The channel accepts text messages only from the user bound during QR login.
See the [WeChat guide](docs/en/weixin.md) for login state, connection settings, task commands, and recovery.

## Architecture and Stack

Built with Next.js, React, TypeScript, Pi Agent, Prisma, and SQLite.
Dependency versions are pinned in `pnpm-lock.yaml`.

Web and WeChat requests enter through the banking HTTP API.
The Pi runtime organizes tool calls and multistep tasks; the security gateway checks identity, parameters, and permissions.
Operations requiring authorization wait for user confirmation or verification before the banking SDK writes to the database.
Model-generated text alone cannot prove that a payment succeeded or identity verification passed.

```text
app/              Web pages and HTTP endpoints
components/       Chat cards, charts, and business UI
channels/weixin/  WeChat transport, sequential confirmation, and verification
agent/            Pi runtime, banking tools, and persisted conversations
planner/          Multistep workflow orchestration
security/         Permissions, verification, limits, and security gateway
banking-sdk/      Simulated banking operations and exact monetary arithmetic
lib/              Shared contracts, database access, and localization
prisma/           Data models and demo seed
tests/            Unit, integration, scenario, and browser acceptance coverage
docs/en/          Developer and user documentation in English
docs/cn/          Developer and user documentation in Chinese
```

Booked amounts are stored as integer minor units; valuations and ratios use exact decimal arithmetic.
Business changes, audit records, and the original execution receipt are committed in one transaction.
See [architecture](docs/en/architecture.md), [security](docs/en/security.md), and [financial values and settlement](docs/en/financial-values.md) for the design and its boundaries.

## Development and Operation

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm typecheck` | Check TypeScript types |
| `pnpm lint` | Run code linting |
| `pnpm test` | Run offline tests |
| `pnpm build` | Build the production application |
| `pnpm start` | Start an existing production build |
| `pnpm db:studio` | Inspect the local database |
| `pnpm scheduler:tick` | Check due tasks and create reminders or pending operations |
| `pnpm agent:recover` | Recover one batch of interrupted runs |
| `pnpm agent:worker` | Start a persistent recovery worker |

The web service does not include a persistent scheduling loop. Configure a separate [scheduler entry point](docs/en/scheduled-tasks.md#deployment-entry-point) for periodic checks.
Due payments still require confirmation and verification.

Tests use isolated databases.
Database tests share `prisma/test.db`; do not run multiple database test processes concurrently in the same checkout.
Browser acceptance runs also need an available Chrome or Chromium installation. See the [testing guide](docs/en/test-cases.md).
Access through another hostname or a reverse proxy requires [trusted origin configuration](docs/en/development.md#trusted-access-addresses).
The default identity and demo verification are not suitable for real financial operations or public production deployment.

## Documentation

| Topic | Guide |
| --- | --- |
| Installation, configuration, database backups, and troubleshooting | [Development guide](docs/en/development.md) |
| Business capabilities and entry points | [Implemented features](docs/en/implemented-features.md) |
| Monthly and annual reports, exports, and model analysis | [Bill reports](docs/en/bill-reports.md) |
| WeChat login, commands, and permissions | [WeChat](docs/en/weixin.md) |
| Events, retries, and recovery | [Durability and recovery](docs/en/agent-durability.md) |
| Conversation archives and model context compaction | [Context compaction](docs/en/context-compaction.md) |
| Permissions and simulation boundaries | [Security](docs/en/security.md), [known limitations](docs/en/known-risks.md) |
| Verification methods and evidence scope | [Testing guide](docs/en/test-cases.md) |

Browse the [documentation index](docs/en/README.md) or the original [competition requirements](req.md).

## Contributing

Use [Issues](https://github.com/Zhenyu2Liang/evox-omni/issues) to report problems or discuss changes.
Include the commit version, `mock` or `live` mode, reproduction steps, and sanitized error details.
Remove API keys, WeChat tokens, and personal data before sharing.

When submitting a pull request:

1. Explain the problem and the resulting behavior change.
2. Add regression coverage for business or authorization changes and update the corresponding documentation.
3. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` sequentially.
4. Keep the lockfile. Do not commit databases, `.env.local`, login state, or generated files under `output/` or `logs/`.

## License

Original project code is licensed under the [Apache License 2.0](LICENSE).
