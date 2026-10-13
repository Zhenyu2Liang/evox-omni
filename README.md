# AI Banking Agent

A financial technology competition demo that turns natural-language requests into inspectable banking operations. Built with Next.js, TypeScript, Pi Core and Prisma/SQLite.

The application uses simulated banking data and verification. No real banking or payment service is connected.

## Features

- Transfers by contact, name or phone, with confirmation and verification.
- Spending analysis, anomaly detection and investment comparison, purchase and redemption.
- Card controls, subscription management and scheduled reminders or payment intents.
- Multi-step workflows with pause, resume, cancellation and manual handoff.
- Persisted agent events, execution receipts and recovery controls.

## Quick start

Requires **Node.js 22.19+** and **pnpm 12.3.4**, as declared in [package.json](package.json).

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

Open [http://localhost:3000/agent](http://localhost:3000/agent). The default model mode is `mock`, which runs without an API key or network access. Try asking for your balance, recent spending or a transfer to a seeded contact. The demo verification code is `123456`.

For live model configuration, including DeepSeek, follow the [development guide](docs/development.md#model-configuration). Put credentials in `.env.local`.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm typecheck` | Check TypeScript types |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run the offline test suite |
| `pnpm build` / `pnpm start` | Build and serve the production application |
| `pnpm db:studio` | Inspect the local database |
| `pnpm db:reset` | Delete the demo database and seed a fresh dataset; stop the application first |
| `pnpm scheduler:tick` | Process one batch of due scheduled intents |

## Documentation

Start with the [documentation index](docs/README.md).

- [Development guide](docs/development.md): configuration, database lifecycle, testing and change workflows.
- [Architecture](docs/architecture.md): module boundaries, authorization and execution paths.
- [Durable agent execution](docs/agent-durability.md): event persistence, retry policies and the Pi Durable decision.
- [Financial values](docs/financial-values.md): Decimal, BigInt, units and settlement rules.
- [Security](docs/security.md) and [known limits](docs/known-risks.md): enforced policy and simulator boundaries.

The competition requirements are recorded in [req.md](req.md).
