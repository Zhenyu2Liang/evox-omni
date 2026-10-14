import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensurePrismaClientGenerated, prismaClientGenerated, prismaClientUsable } from '../../helpers/prisma-cli';

const GENERATOR = `generator client {
  provider = "prisma-client"
  output = "../lib/db/generated"
}
`;
const CURRENT_SCHEMA = `${GENERATOR}
model AgentRun {
  id String @id
  baseRevision Int @default(0) @map("base revision")
}
`;
const STALE_SCHEMA = `${GENERATOR}
model AgentRun {
  id String @id
}
`;

interface ClientFixture { root: string; generatedDir: string }
const fixtures: string[] = [];

function writeGeneratedSchema(client: ClientFixture, schema: string): void {
  writeFileSync(path.join(client.generatedDir, 'internal', 'class.ts'), `export const config = { "inlineSchema": ${JSON.stringify(schema)} };\n`);
}

/** Build workspace-local fake generated output; no driver or database is involved. */
function fixture(generatedSchema = CURRENT_SCHEMA, constructorThrows = false): ClientFixture {
  const scratchParent = path.join(process.cwd(), '.vitest');
  mkdirSync(scratchParent, { recursive: true });
  const root = mkdtempSync(path.join(scratchParent, 'prisma-client-fixture-'));
  fixtures.push(root);
  const generatedDir = path.join(root, 'lib', 'db', 'generated');
  mkdirSync(path.join(generatedDir, 'internal'), { recursive: true });
  mkdirSync(path.join(root, 'prisma'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'client-fixture', private: true, type: 'module' }));
  writeFileSync(path.join(generatedDir, 'client.ts'), constructorThrows
    ? "export class PrismaClient { constructor() { throw new Error('Client stub'); } };\n"
    : 'export class PrismaClient { constructor(options) { if (!options.adapter) throw new Error("Missing adapter"); } async $disconnect() {} };\n');
  writeFileSync(path.join(root, 'lib', 'db', 'database.ts'),
    'import { PrismaClient } from "./generated/client.ts"; export function createDatabaseClient() { return new PrismaClient({ adapter: {} }); }\n');
  const client = { root, generatedDir };
  writeGeneratedSchema(client, generatedSchema);
  writeFileSync(path.join(root, 'prisma', 'schema.prisma'), CURRENT_SCHEMA);
  return client;
}

/** The fake CLI updates only generated metadata and records generation requests. */
function installGenerator(client: ClientFixture, updateSchema: boolean): void {
  const buildDir = path.join(client.root, 'node_modules', 'prisma', 'build');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(path.join(client.root, 'node_modules', 'prisma', 'package.json'), JSON.stringify({ name: 'prisma', type: 'commonjs' }));
  writeFileSync(path.join(buildDir, 'index.js'), `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'generate') process.exit(1);
fs.appendFileSync(path.join(process.cwd(), 'generation-count.txt'), 'generate\\n');
${updateSchema ? `const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
fs.writeFileSync(path.join(process.cwd(), 'lib', 'db', 'generated', 'internal', 'class.ts'), 'export const config = { "inlineSchema": ' + JSON.stringify(schema) + ' };');` : ''}
`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explicit Prisma 7 client generation', () => {
  it('checks the configured output and adapter factory rather than unrelated legacy artifacts', () => {
    const client = fixture();
    const unrelated = path.join(client.root, 'node_modules', '.prisma', 'client');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(path.join(unrelated, 'schema.prisma'), STALE_SCHEMA);
    expect(prismaClientGenerated(client.root)).toBe(true);
    expect(prismaClientUsable(client.root)).toBe(true);
  });

  it('rejects stale generated metadata even when construction would succeed', () => {
    const client = fixture(STALE_SCHEMA);
    expect(prismaClientGenerated(client.root)).toBe(false);
    expect(prismaClientUsable(client.root)).toBe(false);
  });

  it('accepts formatting and comments without treating mapped whitespace as insignificant', () => {
    const client = fixture(`${GENERATOR}// Generated formatting.\nmodel AgentRun {\n id String @id\n baseRevision Int    @default(0) @map("base revision")\n}\n`);
    expect(prismaClientUsable(client.root)).toBe(true);
    writeGeneratedSchema(client, `${GENERATOR}model AgentRun { id String @id baseRevision Int @default(0) @map("baserevision") }`);
    expect(prismaClientGenerated(client.root)).toBe(false);
  });

  it('accepts reordered model constraints while rejecting different constraint definitions', () => {
    const client = fixture(`${GENERATOR}model AgentRun { id String @id baseRevision Int @default(0) @map("base revision") @@unique([id, baseRevision]) @@index([baseRevision]) }`);
    writeFileSync(path.join(client.root, 'prisma', 'schema.prisma'),
      `${GENERATOR}model AgentRun { id String @id baseRevision Int @default(0) @map("base revision") @@index([baseRevision]) @@unique([id, baseRevision]) }`);
    expect(prismaClientGenerated(client.root)).toBe(true);
    writeGeneratedSchema(client, `${GENERATOR}model AgentRun { id String @id baseRevision Int @default(0) @map("base revision") @@unique([id]) @@index([baseRevision]) }`);
    expect(prismaClientGenerated(client.root)).toBe(false);
  });

  it('rejects a changed default without relying solely on model and field names', () => {
    const client = fixture(`${GENERATOR}model AgentRun { id String @id baseRevision Int @default(1) @map("base revision") }`);
    expect(prismaClientGenerated(client.root)).toBe(false);
  });

  it('rejects changed relation actions', () => {
    const client = fixture(`${GENERATOR}model User { id String @id runs AgentRun[] } model AgentRun { id String @id userId String user User @relation(fields: [userId], references: [id], onDelete: Restrict) }`);
    writeFileSync(path.join(client.root, 'prisma', 'schema.prisma'),
      `${GENERATOR}model User { id String @id runs AgentRun[] } model AgentRun { id String @id userId String user User @relation(fields: [userId], references: [id], onDelete: Cascade) }`);
    expect(prismaClientGenerated(client.root)).toBe(false);
  });

  it('rejects a constructor failure even when metadata matches', () => {
    const client = fixture(CURRENT_SCHEMA, true);
    expect(prismaClientGenerated(client.root)).toBe(true);
    expect(prismaClientUsable(client.root)).toBe(false);
  });

  it('regenerates a stale client once and reuses the verified output', () => {
    const client = fixture(STALE_SCHEMA);
    installGenerator(client, true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ensurePrismaClientGenerated(client.root);
    ensurePrismaClientGenerated(client.root);
    expect(readFileSync(path.join(client.root, 'generation-count.txt'), 'utf8')).toBe('generate\n');
    expect(prismaClientUsable(client.root)).toBe(true);
  });

  it('fails when generation reports success but leaves stale metadata', () => {
    const client = fixture(STALE_SCHEMA);
    installGenerator(client, false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => ensurePrismaClientGenerated(client.root)).toThrow('does not match the current schema');
  });

  it('fails when generation leaves a current-schema unusable client', () => {
    const client = fixture(CURRENT_SCHEMA, true);
    installGenerator(client, true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => ensurePrismaClientGenerated(client.root)).toThrow('resolved client is unusable');
  });

  it('rejects missing explicit output despite matching node_modules metadata', () => {
    const client = fixture();
    const unrelated = path.join(client.root, 'node_modules', '.prisma', 'client');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(path.join(unrelated, 'schema.prisma'), CURRENT_SCHEMA);
    rmSync(path.join(client.generatedDir, 'internal', 'class.ts'));
    expect(prismaClientGenerated(client.root)).toBe(false);
    expect(prismaClientUsable(client.root)).toBe(false);
  });

  it('rejects malformed inline schema instead of silently accepting a partial generated file', () => {
    const client = fixture();
    writeFileSync(path.join(client.generatedDir, 'internal', 'class.ts'), 'export const config = { "inlineSchema": 42 };');
    expect(prismaClientGenerated(client.root)).toBe(false);
  });
});
