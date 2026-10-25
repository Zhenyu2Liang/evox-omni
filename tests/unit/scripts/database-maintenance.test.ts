import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = path.resolve('logs/test-artifacts'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'maintenance-')); roots.push(root);
  mkdirSync(path.join(root, 'scripts')); mkdirSync(path.join(root, 'prisma'));
  for (const file of ['db-backup.mjs', 'database-file.mjs', 'investment-share-backfill.mjs']) {
    copyFileSync(path.resolve('scripts', file), path.join(root, 'scripts', file));
  }
  writeFileSync(path.join(root, '.env.local'), 'DATABASE_URL=file:./actual.db\n');
  return root;
}
function run(root: string, script: string, args: string[] = [], options: { db?: string; clock?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
  delete (env as NodeJS.ProcessEnv).DATABASE_URL;
  delete (env as NodeJS.ProcessEnv).__NEXT_PROCESSED_ENV;
  if (options.db) (env as NodeJS.ProcessEnv).DATABASE_URL = options.db;
  const imports: string[] = [];
  if (options.clock) {
    const file = path.join(root, 'clock.mjs');
    writeFileSync(file, "const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-23T12:00:00Z']));}};");
    imports.push('--import', pathToFileURL(file).href);
  }
  return spawnSync(process.execPath, [...imports, path.join(root, 'scripts', script), ...args], { cwd: root, env, encoding: 'utf8' });
}
function createMarker(root: string, name: string, value: string) {
  const db = new DatabaseSync(path.join(root, 'prisma', name));
  db.exec('CREATE TABLE proof(value TEXT)'); db.prepare('INSERT INTO proof VALUES(?)').run(value); db.close();
}
it('backs up the configured database and preserves two snapshots in the same second', () => {
  const root = fixture(); createMarker(root, 'actual.db', 'configured'); createMarker(root, 'dev.db', 'wrong');
  for (let i = 0; i < 2; i++) {
    const result = run(root, 'db-backup.mjs', [], { clock: true });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  }
  const dir = path.join(root, 'logs/db-backups');
  const files = readdirSync(dir).filter(f => f.endsWith('.db'));
  expect(files).toHaveLength(2);
  for (const file of files) {
    const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
    try { expect(db.prepare('SELECT value FROM proof').get()?.value).toBe('configured'); } finally { db.close(); }
    expect(JSON.parse(readFileSync(path.join(dir, file + '.json'), 'utf8')).source).toBe(path.join(root, 'prisma/actual.db'));
  }
});
it('honors an explicit database override ahead of .env.local', () => {
  const root = fixture(); createMarker(root, 'override.db', 'override');
  expect(run(root, 'db-backup.mjs', [], { db: 'file:./override.db' }).status).toBe(0);
  expect(readdirSync(path.join(root, 'logs/db-backups')).filter(f => f.endsWith('.db'))[0]).toContain('override.db');
});
it('does not report an incomplete share upgrade as success', () => {
  const root = fixture(); const db = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  db.exec(`CREATE TABLE InvestmentProduct(id TEXT PRIMARY KEY,code TEXT,latest_net_value_per_unit TEXT);
    CREATE TABLE InvestmentHolding(id TEXT PRIMARY KEY,productId TEXT,principal_amount_minor INTEGER,estimated_market_value TEXT,shares TEXT,shares_estimated INTEGER DEFAULT 0,position_version INTEGER DEFAULT 0,realized_profit_minor INTEGER DEFAULT 0,redemptionHistory TEXT,status TEXT);
    INSERT INTO InvestmentProduct VALUES('p','P',NULL);
    INSERT INTO InvestmentHolding(id,productId,principal_amount_minor,estimated_market_value,status) VALUES('h','p',100000,'1100','HOLDING');`);
  db.close();
  const unresolved = run(root, 'investment-share-backfill.mjs', ['--apply']);
  expect(unresolved.status).toBe(2); expect(unresolved.stdout).toContain('no-net-value');
  const configured = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  configured.exec("UPDATE InvestmentProduct SET latest_net_value_per_unit='1.1'"); configured.close();
  expect(run(root, 'investment-share-backfill.mjs', ['--apply']).status).toBe(0);
  const migrated = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  try { expect(migrated.prepare('SELECT shares,estimated_market_value,position_version FROM InvestmentHolding').get()).toMatchObject({ shares: '1000', estimated_market_value: '1100', position_version: 1 }); }
  finally { migrated.close(); }

  const boundary = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  boundary.exec("UPDATE InvestmentHolding SET shares=NULL,estimated_market_value='1.005'"); boundary.close();
  const refused = run(root, 'investment-share-backfill.mjs', ['--apply']);
  expect(refused.status).toBe(1); expect(refused.stderr).toContain('cent-rounding boundary');
  const unchanged = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  try { expect(unchanged.prepare('SELECT shares,estimated_market_value FROM InvestmentHolding').get()).toMatchObject({ shares: null, estimated_market_value: '1.005' }); }
  finally { unchanged.close(); }
});

it('restores historical partial-redemption profit from original cash and cost without rewriting receipts', () => {
  const root = fixture(); const db = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  db.exec(`CREATE TABLE InvestmentProduct(id TEXT PRIMARY KEY,code TEXT,latest_net_value_per_unit TEXT);
    CREATE TABLE InvestmentHolding(id TEXT PRIMARY KEY,productId TEXT,principal_amount_minor INTEGER,estimated_market_value TEXT,shares TEXT,shares_estimated INTEGER DEFAULT 0,position_version INTEGER DEFAULT 0,realized_profit_minor INTEGER DEFAULT 0,redemptionHistory TEXT,status TEXT);
    INSERT INTO InvestmentProduct VALUES('p','P','1.1');
    INSERT INTO InvestmentHolding(id,productId,principal_amount_minor,estimated_market_value,status) VALUES('h','p',300000,'3107.016','HOLDING');`);
  const history = JSON.stringify([{ redeemedPrincipal: '2000.00', settledAmount: '2071.34', executionKey: 'original' }]);
  db.prepare('UPDATE InvestmentHolding SET redemptionHistory=?').run(history); db.close();
  expect(run(root, 'investment-share-backfill.mjs', ['--apply']).status).toBe(0);
  const after = new DatabaseSync(path.join(root, 'prisma/actual.db'));
  try { expect(after.prepare('SELECT realized_profit_minor,redemptionHistory FROM InvestmentHolding').get()).toMatchObject({ realized_profit_minor: 7134, redemptionHistory: history }); }
  finally { after.close(); }
  expect(run(root, 'investment-share-backfill.mjs', ['--apply']).status).toBe(0);
});
