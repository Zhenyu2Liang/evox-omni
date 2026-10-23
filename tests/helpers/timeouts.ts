/**
 * tests/helpers/timeouts.ts — the shared explicit wall-clock budgets for the specs under `tests/`.
 *
 * WHY PER-CASE DECLARATIONS EXIST AT ALL: the root `vitest.config.ts` pins `testTimeout: 20000`
 * for every spec, and `tests/**` cannot change it (that file is root-owned). Two classes of test
 * bodies are measured close to — or already past — that global budget, and NEITHER has an
 * internal deadline that would surface a recoverable error first:
 *   - chat-driven bodies drive real `POST /api/chat` turns through the mock model, whose entire
 *     cost is ~101 serialised interactive SQLite transactions per turn on the single native
 *     connection (`lib/db/serialized-connection.ts`); mock mode starts no timers at all, so
 *     `testTimeout` is the only boundary;
 *   - cold-DB bodies `spawnSync` the real CLI (`tsx scripts/db-push.ts`, `tsx prisma/seed.ts`),
 *     whose cost is disk/CPU bound and grows with host contention.
 * A `testTimeout` breach is therefore a hard `Test timed out in 20000ms` failure whose cause is
 * environmental, not a business defect.
 *
 * RULE for new specs: a body that drives a real chat turn MUST pass `CHAT_DRIVEN_TEST_TIMEOUT_MS`,
 * and a body that spawns the cold-DB CLI (any `spawnSync`/`cliCommand`) MUST pass
 * `COLD_DB_PROVISION_TEST_TIMEOUT_MS`, each as the third argument of `it(...)`.
 * Use these shared constants — never a bare numeric literal and never a locally re-declared copy.
 */

/**
 * Budget for a body that drives real `POST /api/chat` turns (mock-model path).
 *
 * Measured on one chat-driven case (`tests/app/security-workflow-http.test.ts` it 2): 1919ms
 * standalone, 1622ms inside a full `pnpm test`, 2639ms in a 111-file batch, 1431ms in the
 * `tests/app`+`tests/unit` batch. Under host contention the same file reached 7081/6710/2397ms
 * (≈3.7–4.4×) and one case actually reported `Test timed out in 20000ms` at 24316ms.
 * 60_000 keeps ≈30× headroom over the clean measurement and ≈8× over the worst contended one.
 */
export const CHAT_DRIVEN_TEST_TIMEOUT_MS = 60_000;

/**
 * Budget for a body that provisions a COLD database by spawning the real CLI
 * (`tsx scripts/db-push.ts` against a missing SQLite file, then `tsx prisma/seed.ts`).
 *
 * Measured on a clean machine in `tests/deploy-db-push.test.ts`: 27309ms (first run, with a cold
 * Prisma engine) / 18442ms (second run) for the recreate+seed case (it 1), and 17145ms / 16954ms
 * for the missing-file case (it 3) — i.e. up to 137% and 86% of the global 20000ms budget — while
 * the pure-validation case (it 2) costs 1ms and needs no budget.
 * Each spawn pays a full `tsx` startup plus Prisma schema-engine work, so it multiplies under
 * contention exactly like the chat-driven bodies; 120_000 keeps ≈4× headroom over the slowest
 * clean measurement.
 */
export const COLD_DB_PROVISION_TEST_TIMEOUT_MS = 120_000;
