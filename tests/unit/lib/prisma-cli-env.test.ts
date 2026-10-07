/**
 * prisma-cli-env.test.ts — PURE unit spec for the shared schema-engine ENVIRONMENT policy in
 * `@/lib/prisma-cli-env` (the NON-TEST module both the test entry points and the deployment script
 * `scripts/db-push.ts` import).
 *
 * WHY THIS MATTERS: pinning `RUST_LOG=info` is the ROOT-CAUSE fix for the opaque EMPTY
 * `Error: Schema engine error:` a cold checkout hits (see the module doc). The policy has two forms —
 * a MUTATING `pinSchemaEngineLogging(env)` used once at entry-point module load, and a
 * NON-mutating `prismaCliEnv(env)` building the env for ONE spawned CLI — so this spec locks BOTH
 * semantics: the exact pinned value, the `RUST_BACKTRACE` default/preserve rule, and the
 * mutate-vs-copy contract. No DB and no model are needed.
 *
 * NOTE: Next augments `NodeJS.ProcessEnv` (via `global.d.ts`) to REQUIRE a `NODE_ENV` key, so every
 * ambient-env literal below carries `NODE_ENV: 'test'`; it is irrelevant to the assertions and is
 * asserted to survive the copy helper like any other unrelated key.
 */
import { describe, expect, it } from 'vitest';
import { prismaCliEnv, pinSchemaEngineLogging, SCHEMA_ENGINE_RUST_LOG } from '@/lib/prisma-cli-env';

describe('SCHEMA_ENGINE_RUST_LOG — the pinning policy value', () => {
  it('is `info`, the only log level that keeps Prisma schema-engine error reporting intact', () => {
    expect(SCHEMA_ENGINE_RUST_LOG).toBe('info');
  });
});

describe('pinSchemaEngineLogging — MUTATES and returns the given env', () => {
  it('forces RUST_LOG to `info`, overriding a suppression-worthy ambient value', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', RUST_LOG: 'warn' };
    const returned = pinSchemaEngineLogging(env);
    expect(env.RUST_LOG).toBe('info');
    // Mutates in place and returns the SAME object (callers rely on both).
    expect(returned).toBe(env);
  });

  it('defaults RUST_BACKTRACE to `1` when absent', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    pinSchemaEngineLogging(env);
    expect(env.RUST_BACKTRACE).toBe('1');
  });

  it('PRESERVES an existing RUST_BACKTRACE', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', RUST_BACKTRACE: 'full' };
    pinSchemaEngineLogging(env);
    expect(env.RUST_BACKTRACE).toBe('full');
  });

  it('defaults to process.env and leaves unrelated keys untouched', () => {
    const prevLog = process.env.RUST_LOG;
    const prevBacktrace = process.env.RUST_BACKTRACE;
    try {
      process.env.RUST_LOG = 'warn';
      delete process.env.RUST_BACKTRACE;
      const returned = pinSchemaEngineLogging();
      expect(returned).toBe(process.env);
      expect(process.env.RUST_LOG).toBe('info');
      expect(process.env.RUST_BACKTRACE).toBe('1');
    } finally {
      if (prevLog === undefined) delete process.env.RUST_LOG;
      else process.env.RUST_LOG = prevLog;
      if (prevBacktrace === undefined) delete process.env.RUST_BACKTRACE;
      else process.env.RUST_BACKTRACE = prevBacktrace;
    }
  });
});

describe('prismaCliEnv — returns a NEW env, never mutating its input', () => {
  it('pins RUST_LOG to `info` and defaults RUST_BACKTRACE to `1`', () => {
    const input: NodeJS.ProcessEnv = { NODE_ENV: 'test', RUST_LOG: 'warn' };
    const out = prismaCliEnv(input);
    expect(out.RUST_LOG).toBe('info');
    expect(out.RUST_BACKTRACE).toBe('1');
  });

  it('returns a DIFFERENT object and leaves the input untouched', () => {
    const input: NodeJS.ProcessEnv = { NODE_ENV: 'test', RUST_LOG: 'warn' };
    const out = prismaCliEnv(input);
    expect(out).not.toBe(input);
    expect(input.RUST_LOG).toBe('warn');
    expect('RUST_BACKTRACE' in input).toBe(false);
  });

  it('preserves an existing RUST_BACKTRACE', () => {
    expect(prismaCliEnv({ NODE_ENV: 'test', RUST_BACKTRACE: 'full' }).RUST_BACKTRACE).toBe('full');
  });

  it('carries every other ambient key through to the child env', () => {
    const out = prismaCliEnv({ NODE_ENV: 'test', DATABASE_URL: 'file:./dev.db', LLM_MODE: 'mock', PATH: '/x' });
    expect(out.DATABASE_URL).toBe('file:./dev.db');
    expect(out.LLM_MODE).toBe('mock');
    expect(out.PATH).toBe('/x');
  });

  it('defaults to process.env when called with no argument, without mutating process.env', () => {
    const prevLog = process.env.RUST_LOG;
    try {
      process.env.RUST_LOG = 'warn';
      const out = prismaCliEnv(undefined);
      expect(out.RUST_LOG).toBe('info');
      // The REAL process env must not be rewritten by the copy helper.
      expect(process.env.RUST_LOG).toBe('warn');
    } finally {
      if (prevLog === undefined) delete process.env.RUST_LOG;
      else process.env.RUST_LOG = prevLog;
    }
  });
});
