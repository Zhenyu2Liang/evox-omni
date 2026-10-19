# Non-live baseline — raw-HTTP date-tampering boundary test (`tests/e2e/date-tamper-boundary.e2e.ts`)

Evidence-only run of the standalone RAW-HTTP boundary entry at current HEAD. No browser, no model:
every step is a plain `fetch` against a booted Next.js app, and every financial claim is proven against
the authoritative SQLite rows read back afterwards. No product code was changed, no assertion was
weakened, skipped or deleted, and `tests/e2e/CONTEXT.md` / `tests/e2e/LIVE-ACCEPTANCE-REPORT.md` were
left untouched.

## Run identity

| Item | Value |
| --- | --- |
| Commit SHA tested (`git rev-parse HEAD`) | `62392c0740673e2a79cf83ac0df5784e4780422a` |
| Harness | `tests/e2e/date-tamper-boundary.e2e.ts` |
| Exact command | `pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` |
| Model mode | mock — and in practice **no model is involved at all** (`LLM_MODE=mock` for the booted app; `/api/health` → `llmMode=mock` verified) |
| Browser | none — no Playwright browser is launched |
| Isolated DB | `prisma/live-acceptance-date-tamper.db` (+ `-wal`/`-shm`/`-journal`, plus the harness's own `.backup.db`) |
| DB files explicitly NOT used | `prisma/e2e.db` (mock browser suite), `prisma/test.db` (Vitest), `prisma/dev.db` (shared dev) — verified absent/untouched by this entry |
| DB lifecycle | all files deleted → `prisma db push` → probe → `tsx prisma/seed.ts` on every run |
| Dev server | real `next dev` on a free port (`.next-e2e` dist dir) — this run: `pid=64616 → http://localhost:63400`; port freed afterwards: `YES` |
| Business clock | `demoNow()` = `2026-09-25T04:00:00.000Z`, business month `2026-9`, window `[2026-08-31T16:00:00.000Z, 2026-09-30T16:00:00.000Z)` (UTC+08:00) |
| Full stdout/stderr | `logs/date-tamper-head.log` (gitignored) |
| Machine-readable evidence | `logs/date-tamper-evidence.json` (23,412 B, gitignored) |
| Exit code | **0** — read from the entry's own process exit status (delayed-expansion `!ERRORLEVEL!` recorded `EXIT=0`), and the summary line reports `fail=0`, so exit code and verdicts agree |

This report certifies commit `62392c0740673e2a79cf83ac0df5784e4780422a`.
`git diff 7a7a4d32a6a1622deb7647ab6142fb7991b76805 62392c0740673e2a79cf83ac0df5784e4780422a` touches only
`output/playwright/live/` evidence files, so the route contracts exercised here are the same as at `7a7a4d3`.

## Summary line (verbatim)

```
SUMMARY cases=9 pass=8 fail=0 skip=1 → exit code 0（本入口为 RAW-HTTP 边界测试：不驱动浏览器、不调用模型、结论仅覆盖 HTTP 响应 + SQLite 行）
```

Head of the log (verbatim):

```
=== date-tamper-boundary.e2e.ts — RAW-HTTP BOUNDARY TEST (no browser, no model) ===
repo        : D:\projects\banking-agent\.genesis\workers\worker_T5_A46
isolated db : D:\projects\banking-agent\.genesis\workers\worker_T5_A46\prisma\live-acceptance-date-tamper.db
dist dir    : .next-e2e
business    : now=2026-09-25T04:00:00.000Z month=2026-9 window=[2026-08-31T16:00:00.000Z, 2026-09-30T16:00:00.000Z)
· 准备隔离数据库（删除 → prisma db push → tsx prisma/seed.ts）…
· 隔离数据库就绪
· next dev 启动中：port=63400 pid=64616
· 应用就绪：http://localhost:63400（llmMode=mock 已由 /api/health 校验）
```

Tail of the log (verbatim):

```
port 63400 freed: YES
evidence    : D:\projects\banking-agent\.genesis\workers\worker_T5_A46\logs\date-tamper-evidence.json
SUMMARY cases=9 pass=8 fail=0 skip=1 → exit code 0（本入口为 RAW-HTTP 边界测试：不驱动浏览器、不调用模型、结论仅覆盖 HTTP 响应 + SQLite 行）
EXIT=0
```

## Per-case verdicts (9 cases: 8 PASS, 0 FAIL, 1 SKIP)

| Case id | Kind | Verdict | Assertion (verbatim, condensed from the case's `detail`) |
| --- | --- | --- | --- |
| `s0-virtual-card-100-limit` | SETUP | **PASS** | 虚拟卡 `cmvc0qkyk0002d0f8emp2bjns` 经真实 `POST /api/cards` proposal (`requestId=76cacf06-c349-4f20-b42b-d7e35a853940`, `cardchange_f127acaa5f34d04d8c6548cc8e23c02d`) + `POST /api/cards/changes/[id]/verify` (MFA `123456`) 建立：`type=VIRTUAL`、`status=ACTIVE`、`numberMasked=****3218`、`monthlyLimit=100.00`、`linkedAccountId=acct_checking`（HTTP 与 SQLite 一致） |
| `c1-consume-normal` | CASE | **PASS** | 正常消费 `10.00`：余额 `23580.00 → 23570.00`（恰好 −10.00）、`CARD`/`DEBIT` 流水 +1、`CardConsumption` +1（服务端落账 `occurredAt=1790308800000`） |
| `c2-prev-month-tamper` | CASE | **PASS** | 上月伪造时间 `2026-08-01T04:00:00.000Z`（业务月 2026-8）消费 `90.00` → `400` `VALIDATION`「Consumption time is server-owned: 'occurredAt' must not be sent」；余额仍 `23570.00`、无新流水、无新 `CardConsumption`、`forgedAmountRows=0` |
| `c3-month-total-11` | CASE | **PASS** | 正常消费 `1.00`：本业务月该卡入账合计 = `11.00`（期望 `11.00`），`90.00` 从未进入任何月份的入账合计 |
| `c4-future-tamper` | CASE | **PASS** | 未来时间 `2026-12-24T04:00:00.000Z` 消费 `90.00` → `400` `VALIDATION`（同上文案）；余额仍 `23569.00`、无新流水 |
| `c5-malformed-tamper` | CASE | **PASS** | 畸形 `occurredAt="not-a-date"` 消费 `90.00` → `400` `VALIDATION`（同上文案）；零副作用 |
| `c6-null-tamper` | CASE | **PASS** | `occurredAt: null` 消费 `90.00` → `400` `VALIDATION`（同上文案）；零副作用 |
| `c7-payable-allowance` | CASE | **PASS** | `GET /api/cards` 可支付金额 = `89.00`（`min(账户可用 23569.00, 剩余月限额 89.00)`）；若 `90.00` 曾入账，此处会是 `-1.00` |
| `x1-model-seam-http` | EXTRA | **SKIP** | 模型侧接缝（`agent/tools/card.ts#runConsumeVirtualCard` 的时间字段拒绝）无法在无真实模型的前提下经 HTTP 驱动：mock 提供者未脚本化 `consume_virtual_card`，也没有携带任意工具参数创建 `PendingAction` 的 HTTP 路由；本用例只断言路由层契约（`POST /api/cards/[id]/consume`），不声称覆盖模型侧 |

### Exact repro chain (the numbers the objective asks for)

Virtual card with a `100.00` CNY monthly limit → consume `10.00` normally → `POST` `90.00` with a
**previous-month** `occurredAt` ⇒ `400 VALIDATION`, zero movement → consume `1.00` normally ⇒ the
current business month books exactly `11.00`.

| Step | HTTP request body | HTTP result | `acct_checking` balance | `CardConsumption` count | card month booked total |
| --- | --- | --- | --- | --- | --- |
| setup (`s0`) | `POST /api/cards` `{"requestId":"…","type":"VIRTUAL","monthlyLimit":"100.00","linkedAccountId":"acct_checking"}` then `verify {"code":"123456"}` | `200` / `200` (`status":"executed"`, card `type=VIRTUAL`, `status=ACTIVE`, `monthlyLimit=100.00`) | `23580.00` | `0` | `0.00` |
| `c1` | `{"amount":"10.00","category":"购物","merchant":"边界测试商户"}` | `200` (server-stamped `occurredAt=1790308800000`) | `23580.00 → 23570.00` | `0 → 1` | `10.00` |
| `c2` forged previous month | `{"amount":"90.00","occurredAt":"2026-08-01T04:00:00.000Z"}` | `400` `{"ok":false,"error":{"code":"VALIDATION","message":"Consumption time is server-owned: 'occurredAt' must not be sent"}}` | `23570.00` (**unchanged**) | `1` (**unchanged**) | `10.00` (**unchanged**) |
| `c3` | `{"amount":"1.00","category":"餐饮","merchant":"边界测试商户2"}` | `200` | `23570.00 → 23569.00` | `1 → 2` | `10.00 → 11.00` ✔ exactly `11.00` |
| `c4` future date | `{"amount":"90.00","occurredAt":"2026-12-24T04:00:00.000Z"}` | `400` `VALIDATION` (same message) | `23569.00` unchanged | `2` unchanged | `11.00` unchanged |
| `c5` malformed date | `{"amount":"90.00","occurredAt":"not-a-date"}` | `400` `VALIDATION` (same message) | `23569.00` unchanged | `2` unchanged | `11.00` unchanged |
| `c6` null date | `{"amount":"90.00","occurredAt":null}` | `400` `VALIDATION` (same message) | `23569.00` unchanged | `2` unchanged | `11.00` unchanged |
| `c7` payable | `GET /api/cards` | `200` | `23569.00` | `2` | payable = `89.00` = `min(23569.00, 100.00 − 11.00)` |

Additional ledger cross-checks recorded for `c2`–`c6`: `forgedAmountRows = 0` in every before/after
snapshot (no row carries the forged `90.00`), and `cardChannelDebitCount` moves only with the two real
spends (`90 → 91 → 92`, month debit total `11778.07 → 11788.07 → 11789.07`), so the refusals created no
`channel=CARD`/`direction=DEBIT` ledger rows either.

The refusal is an up-front `VALIDATION` on the presence of the key — not a silent strip: the body is
rejected before any booking, which is exactly why `occurredAt: null` and `"not-a-date"` are refused with
the same message as a well-formed back/forward date.

## Not verified by this run

- The model-facing seam `agent/tools/card.ts#runConsumeVirtualCard` `CLIENT_TIME_FIELDS` rejection was **not**
  executed (`x1-model-seam-http` is an honest SKIP: the mock provider has no `consume_virtual_card` intent and
  no HTTP route creates a `PendingAction` with arbitrary tool arguments).
- Browser UI: this entry drives no UI, so `app/cards/CardConsumeDialog.tsx` rendering/validation and the `/cards`
  page are not covered here (they are covered by `tests/e2e/acceptance.e2e.ts` and, with a live model,
  `tests/e2e/live-acceptance.e2e.ts` — neither is in scope of this report except the mock suite's own report).
- No live model, no production build, no cluster concurrency, no real banking rail.
