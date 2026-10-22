/**
 * Derive `shares` for legacy investment holdings that predate the 「净值 + 份额」 accounting model.
 *
 * Contract: `docs/cn/investments.md` § 历史持仓
 *   shares = FLOOR(market value ÷ net value, 6 fractional digits)
 *   a product that publishes no net value is NEVER fabricated — the holding stays untouched and is
 *   reported as 历史数据不足
 * A derived share count is an ESTIMATE, not a purchase record: every row the run writes is flagged
 * `shares_estimated = 1`, so the read side reports `valueBasis: 'MIGRATED_ESTIMATE'` and the UI shows
 * 「（估算）」 instead of passing the derivation off as an exact net-value position.
 *
 * The market value is the holding's stored `estimatedMarketValue`, falling back to the remaining cost
 * basis (`principalAmountMinor / 100`) when the stored snapshot is NULL. With `--apply` the stored
 * `estimatedMarketValue` is rewritten to the exact product `shares × net value`, so the persisted
 * market value and shares stay self-consistent. Both figures move by less than 0.01 CNY per holding;
 * a larger drift means the derivation would change the economics, so the run fails without writing.
 *
 * Decimal math is BigInt scaling over canonical decimal text — the same style as
 * `banking-sdk/valuation.ts` (`scaledHalfUp` / scaled-decimal). No floating point touches money.
 *
 * WHY `node:sqlite` instead of the generated Prisma client: the `prisma-client` generator emits
 * TypeScript only (`lib/db/generated/*.ts`), which plain `node` cannot import without a TS loader.
 * This script therefore speaks SQLite directly and stays dependency-free.
 *
 * Run with `node scripts/investment-share-backfill.mjs` (dry run) or `... --apply`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Share precision from the investment contract: at most 6 fractional digits. */
const SHARE_FRACTION_DIGITS = 6;
const SHARE_SCALE = 10n ** BigInt(SHARE_FRACTION_DIGITS);
/** CNY cents per unit: the drift bound is "less than 0.01 CNY", i.e. strictly below one cent. */
const MINOR_PER_UNIT = 100n;
/** Repository root, resolved from this script so the command works from any working directory. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The legacy snapshot. `shares_estimated` is read here so a database that lacks the current column is
 * reported by this SELECT (with the actionable `pnpm db:push` hint) instead of by the guarded write.
 */
const HOLDING_QUERY = `
  SELECT h.id                     AS holdingId,
         h.principal_amount_minor AS principalAmountMinor,
         h.estimated_market_value AS estimatedMarketValue,
         h.shares                 AS shares,
         h.shares_estimated       AS sharesEstimated,
         h.status                 AS status,
         p.code                   AS productCode,
         p.latest_net_value_per_unit AS latestNetValuePerUnit
    FROM "InvestmentHolding" h
    LEFT JOIN "InvestmentProduct" p ON p.id = h.productId
   WHERE h.status = 'HOLDING' AND h.shares IS NULL
   ORDER BY p.code, h.id
`;

/** The guarded write: still legacy, still open, still not yet derived — so the run is idempotent. */
const UPDATE_QUERY = `
  UPDATE "InvestmentHolding"
     SET shares = ?, estimated_market_value = ?, shares_estimated = 1
   WHERE id = ? AND status = 'HOLDING' AND shares IS NULL
`;

/**
 * Resolve the SQLite file the application uses, matching `lib/db/url.ts`: a relative `file:` path is
 * anchored at `prisma/`, and `DATABASE_URL` defaults to `file:./dev.db` → `prisma/dev.db`.
 * The environment file is never read here; only an explicitly exported variable is honored.
 */
function resolveDatabaseFile() {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) throw new Error('The banking demo requires a SQLite file URL in DATABASE_URL.');
  const filename = url.slice('file:'.length).split('?')[0];
  if (!filename) throw new Error('The SQLite database file name must not be empty.');
  if (filename === ':memory:') throw new Error('The share backfill requires a persistent SQLite file.');
  return path.isAbsolute(filename) ? filename : path.resolve(REPO_ROOT, 'prisma', filename);
}

/** Print a repository-relative path so the output stays stable across machines. */
function display(file) {
  const relative = path.relative(REPO_ROOT, file);
  return relative === '' ? file : relative;
}

/** Split canonical non-negative decimal text into an integer coefficient and its fractional scale. */
function parseDecimalText(value, label) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) throw new Error(`Invalid ${label} decimal text: ${value}`);
  const fraction = match[2] ?? '';
  return { coefficient: BigInt(match[1] + fraction), scale: fraction.length };
}

/** Render a coefficient scaled by `10^scale` as canonical decimal text (trailing zeros removed). */
function formatScaled(coefficient, scale) {
  if (scale === 0) return coefficient.toString();
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const integer = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${fraction === '' ? integer : `${integer}.${fraction}`}`;
}

/** BigInt addition of two scaled decimals, aligning to the wider scale. */
function addScaled(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

/** Exact absolute difference `|left − right|` of two canonical decimal strings. */
function absoluteDifference(leftText, rightText) {
  const left = parseDecimalText(leftText, 'left operand');
  const right = parseDecimalText(rightText, 'right operand');
  const scale = Math.max(left.scale, right.scale);
  const difference =
    left.coefficient * 10n ** BigInt(scale - left.scale) - right.coefficient * 10n ** BigInt(scale - right.scale);
  return { coefficient: difference < 0n ? -difference : difference, scale };
}

/** `FLOOR(market value ÷ net value, 6 fractional digits)` as a coefficient scaled by `10^6`. */
function floorSharesScaled(marketValueText, netValueText) {
  const market = parseDecimalText(marketValueText, 'market value');
  const net = parseDecimalText(netValueText, 'net value');
  // Aligned integer division truncates toward zero, which is FLOOR for non-negative operands.
  return (market.coefficient * SHARE_SCALE * 10n ** BigInt(net.scale)) / (net.coefficient * 10n ** BigInt(market.scale));
}

/** The exact unrounded product `shares × net value`, as canonical decimal text. */
function multiplySharesByNetValue(sharesScaled, netValueText) {
  const net = parseDecimalText(netValueText, 'net value');
  return formatScaled(sharesScaled * net.coefficient, SHARE_FRACTION_DIGITS + net.scale);
}

/** `true` when the drift is NOT "less than 0.01 CNY" — compared exactly, never in floating point. */
function exceedsDriftBound(drift) {
  return drift.coefficient * MINOR_PER_UNIT >= 10n ** BigInt(drift.scale);
}

/** Print an aligned table; the numeric columns are right-aligned so their decimals line up. */
function renderTable(headers, rows, rightAligned) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = values =>
    values
      .map((value, index) => (rightAligned.includes(index) ? value.padStart(widths[index], ' ') : value.padEnd(widths[index], ' ')))
      .join('  ');
  console.log(line(headers));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

/** Plan the derivation for one legacy holding without touching the database. */
function planHolding(row) {
  const netValueText = row.latestNetValuePerUnit;
  const fallbackText = formatScaled(row.principalAmountMinor, 2);
  const oldMarketValueText = row.estimatedMarketValue ?? fallbackText;
  const base = {
    holdingId: row.holdingId,
    productCode: row.productCode ?? '(missing product)',
    oldMarketValueText,
    usedFallback: row.estimatedMarketValue === null,
    netValueText,
  };
  if (netValueText === null) return { ...base, outcome: 'skipped', reason: 'no-net-value' };
  if (parseDecimalText(netValueText, 'net value').coefficient === 0n) {
    return { ...base, outcome: 'skipped', reason: 'net-value-not-positive' };
  }
  const sharesScaled = floorSharesScaled(oldMarketValueText, netValueText);
  const newMarketValueText = multiplySharesByNetValue(sharesScaled, netValueText);
  return {
    ...base,
    outcome: 'derived',
    sharesText: formatScaled(sharesScaled, SHARE_FRACTION_DIGITS),
    newMarketValueText,
    drift: absoluteDifference(newMarketValueText, oldMarketValueText),
  };
}

/** Read the legacy holdings; a stale schema is reported as an actionable error, never silently empty. */
function readLegacyHoldings(database) {
  try {
    const select = database.prepare(HOLDING_QUERY);
    // Remaining cost basis is booked in exact BigInt cents; never let it pass through a JS number.
    select.setReadBigInts(true);
    return select.all();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown SQLite error';
    throw new Error(`Could not read legacy holdings: ${reason}. Run \`pnpm db:push\` to sync the current schema.`);
  }
}

function parseArguments(argv) {
  const unknown = argv.filter(argument => argument !== '--apply');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')}. Supported: --apply`);
  return { apply: argv.includes('--apply') };
}

async function runBackfill() {
  const { apply } = parseArguments(process.argv.slice(2));
  const databaseFile = resolveDatabaseFile();
  if (!existsSync(databaseFile)) {
    console.error(`[backfill] Database not found: ${display(databaseFile)}`);
    console.error('[backfill] Create it with `pnpm db:push` before deriving legacy shares.');
    return 1;
  }

  const database = new DatabaseSync(databaseFile);
  try {
    const holdings = readLegacyHoldings(database);

    console.log(`[backfill] database: ${display(databaseFile)}`);
    console.log(`[backfill] mode: ${apply ? 'apply' : 'dry run (no database writes)'}`);
    console.log(`[backfill] legacy holdings (status HOLDING, shares IS NULL): ${holdings.length}`);

    const plans = holdings.map(row => planHolding(row));
    if (plans.length > 0) {
      renderTable(
        ['holding', 'product', 'old market value', 'net value', 'shares', 'new market value', 'drift', 'outcome'],
        plans.map(plan => [
          plan.holdingId,
          plan.productCode,
          plan.oldMarketValueText,
          plan.netValueText ?? '-',
          plan.sharesText ?? '-',
          plan.newMarketValueText ?? '-',
          plan.drift ? formatScaled(plan.drift.coefficient, plan.drift.scale) : '-',
          plan.outcome === 'derived'
            ? `derived${plan.usedFallback ? ' (cost basis)' : ''}`
            : `skipped: ${plan.reason}`,
        ]),
        [2, 3, 4, 5, 6],
      );
    }

    const derived = plans.filter(plan => plan.outcome === 'derived');
    const skipped = plans.filter(plan => plan.outcome === 'skipped');

    // Refuse the whole run when the derivation would move the economics of any holding.
    const violations = derived.filter(plan => exceedsDriftBound(plan.drift));
    if (violations.length > 0) {
      for (const plan of violations) {
        console.error(
          `[backfill] Drift exceeds 0.01 CNY for ${plan.holdingId}: ${formatScaled(plan.drift.coefficient, plan.drift.scale)}`,
        );
      }
      console.error('[backfill] Nothing was written. Recheck the stored market value and the product net value.');
      return 1;
    }

    let written = 0;
    if (apply && derived.length > 0) {
      const update = database.prepare(UPDATE_QUERY);
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const plan of derived) {
          const result = update.run(plan.sharesText, plan.newMarketValueText, plan.holdingId);
          written += Number(result.changes);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }

    const totalDrift = derived.reduce((total, plan) => addScaled(total, plan.drift), { coefficient: 0n, scale: 0 });
    console.log(`[backfill] migrated: ${apply ? written : derived.length}${apply ? '' : ' (dry run)'}`);
    if (derived.length > 0) {
      // A derived share count is an estimate: say so in BOTH modes, so an operator never mistakes the
      // rewrite for a recovered purchase record.
      console.log(
        apply
          ? '[backfill] derived shares are flagged as estimated (shares_estimated = 1) and displayed as 估算'
          : '[backfill] derived shares will be flagged as estimated (shares_estimated = 1) — displayed as 估算, never as an exact net-value position',
      );
    }
    if (apply && written !== derived.length) {
      console.log(`[backfill] concurrent changes skipped: ${derived.length - written}`);
    }
    console.log(`[backfill] skipped (历史数据不足): ${skipped.length}`);
    for (const plan of skipped) {
      console.log(`[backfill]   ${plan.holdingId} ${plan.productCode}: ${plan.reason} — left untouched, no shares fabricated`);
    }
    console.log(`[backfill] total economic-value drift: ${formatScaled(totalDrift.coefficient, totalDrift.scale)} CNY`);
    if (!apply) console.log('[backfill] Re-run with --apply to persist the derived shares.');
    return 0;
  } finally {
    database.close();
  }
}

try {
  process.exitCode = await runBackfill();
} catch (error) {
  console.error(`[backfill] ${error instanceof Error ? error.message : 'Share backfill failed.'}`);
  process.exitCode = 1;
}
