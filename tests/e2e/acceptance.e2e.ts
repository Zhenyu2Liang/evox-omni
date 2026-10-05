/**
 * `tests/e2e/acceptance.e2e.ts` — the SINGLE real-browser end-to-end acceptance entry point.
 *
 * It boots the REAL Next.js dev server on a free port, waits for `/api/health`, launches the machine's
 * real headless Chrome (via `playwright-core`, no browser download), drives the REAL `/agent` UI and
 * asserts on RENDERED DOM — never on API responses alone. Only the model is scripted (`LLM_MODE=mock`).
 *
 * Run:  npx tsx tests/e2e/acceptance.e2e.ts
 *
 * Output contract: EXACTLY one line per journey — `PASS|FAIL|SKIP <journey> — <evidence|reason>`.
 * The process exits non-zero iff ANY journey FAILED (a SKIP does not fail the run). The dev server's
 * whole process tree and the browser are always torn down (success, failure and unexpected errors).
 *
 * NOTE: the filename deliberately ends in `.e2e.ts` (NOT `.test.`/`.spec.`), so it does NOT match
 * vitest's include glob `tests/**\/*.{test,spec}.ts` and never runs under `npm run test`.
 */
import type { Browser, Page } from 'playwright-core';
import {
  NAV_TIMEOUT_MS,
  SELECTORS,
  clickConfirm,
  clickPlanControl,
  createReporter,
  errText,
  gotoAgent,
  hasAssistantText,
  launchBrowser,
  mfaCardPresent,
  pickFreePort,
  resolveBrowserExecutable,
  runJourney,
  setActiveBrowser,
  startDevServer,
  submitChat,
  submitMfa,
  waitForAssistantText,
  waitForConfirmCard,
  waitForHealth,
  waitForMfaCard,
  waitForPlanStatus,
  waitForStatusText,
  withPage,
  type DevServer,
} from './helpers';

/** Exact mock-mode trigger phrases, verified against `agent/providers/mock-responder.ts`. */
const MSG = {
  /** YELLOW transfer (≤ ¥1000) → confirmation card. */
  transferYellow: '给张伟转200元',
  /** RED transfer (> ¥1000) → MFA card (mock code `123456`). */
  transferRed: '给张伟转2000元',
  /** GATED conditional plan: analyze(GREEN) → check → set_card_limit(YELLOW) ⇒ parks at 等待确认. */
  gatedPlan: '如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元',
} as const;

/** Assistant narration lead emitted on a completed transfer (`NARRATION_LEAD.transfer_money`). */
const TRANSFER_OK_NARRATION = '转账处理结果：';

/** Wait for the chat page to be interactive again after a client-side `page.reload()`. */
async function waitForComposer(page: Page): Promise<void> {
  await page.locator(SELECTORS.composer).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
}

// --- journeys (each asserts on RENDERED DOM) ----------------------------------------------------

/** (a) YELLOW transfer: confirmation card → 确认 → the completed-transfer narration appears. */
async function journeyTransferConfirm(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferYellow);
      await waitForConfirmCard(page);
      await clickConfirm(page);
      await waitForAssistantText(page, TRANSFER_OK_NARRATION);
      return `提交「${MSG.transferYellow}」→ 确认卡片(确认/取消) → 点击 确认 → 助手消息出现「${TRANSFER_OK_NARRATION}」`;
    },
    { label: 'a-transfer-confirm' },
  );
}

/**
 * (b) RED transfer MFA, both legs — each in a FRESH context:
 *   leg 1: correct code `123456` → transfer executes (success narration).
 *   leg 2: wrong code `000000` → `验证失败，已尝试 1 次` shows, MFA card STAYS, and NO success narration.
 */
async function journeyTransferMfa(browser: Browser, baseUrl: string): Promise<string> {
  const ok = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      await waitForAssistantText(page, TRANSFER_OK_NARRATION);
      return `正确验证码 123456 → 助手消息出现「${TRANSFER_OK_NARRATION}」`;
    },
    { label: 'b1-transfer-mfa-ok' },
  );

  const wrong = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await submitMfa(page, '000000');
      await waitForStatusText(page, '验证失败，已尝试1次');
      if (!(await mfaCardPresent(page))) {
        throw new Error('错误验证码后 MFA 卡片消失（应保留以允许重试）');
      }
      if (await hasAssistantText(page, TRANSFER_OK_NARRATION)) {
        throw new Error('错误验证码后出现转账成功叙述 —— 转账不应发生');
      }
      return '错误验证码 000000 → role=status「验证失败，已尝试 1 次」，MFA 卡片保留，无成功叙述';
    },
    { label: 'b2-transfer-mfa-wrong' },
  );

  return `正确码：${ok} ｜ 错误码：${wrong}`;
}

/**
 * (c) GATED plan → 等待确认 → 暂停 → 已暂停 → 继续.
 *
 * HONEST REPORTING: per planner semantics (`planner/CONTEXT.md`), `runPlan` on a snapshot whose gated
 * node is still parked RE-ATTEMPTS that node (parked is NOT terminal), so resuming re-parks the plan.
 * We therefore assert the REAL post-resume badge (`等待确认`), or `已完成` if it ever reaches it, and
 * report exactly which was observed — we NEVER fake completion.
 */
async function journeyPlanPauseResume(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.gatedPlan);
      await waitForPlanStatus(page, '等待确认');
      await clickPlanControl(page, '暂停');
      await waitForPlanStatus(page, '已暂停');
      await clickPlanControl(page, '继续');
      const after = await waitForPlanStatus(page, ['等待确认', '已完成'], 90_000);
      const note =
        after === '已完成'
          ? '恢复后达到 已完成'
          : '恢复后重新停在 等待确认（门控节点再次挂起，未达 已完成 —— 见 CONTEXT.md「已知限制」，未伪造完成）';
      return `门控计划 → 等待确认 → 暂停 → 已暂停 → 继续 → ${after}（${note}）`;
    },
    { label: 'c-plan-pause-resume' },
  );
}

/** (d) GATED plan → 等待确认 → click the plan card's 取消 → 已取消. */
async function journeyPlanCancel(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.gatedPlan);
      await waitForPlanStatus(page, '等待确认');
      await clickPlanControl(page, '取消');
      await waitForPlanStatus(page, '已取消');
      return '门控计划 → 等待确认 → 点击计划卡「取消」→ 已取消';
    },
    { label: 'd-plan-cancel' },
  );
}

/**
 * (e) REFRESH → action-entry recovery, in the SAME context across reload (the HttpOnly
 * `banking_session` cookie persists, so the server state is reachable):
 *   leg 1: park a YELLOW transfer → reload → the ConfirmationCard(确认/取消) is RESTORED.
 *   leg 2 (fresh context): park a RED transfer → reload → the MfaCard(身份验证) is RESTORED.
 */
async function journeyRefreshRecovery(browser: Browser, baseUrl: string): Promise<string> {
  const yellow = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferYellow);
      await waitForConfirmCard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposer(page);
      await waitForConfirmCard(page);
      return 'YELLOW 转账挂起 → 同一 context reload → ConfirmationCard(确认/取消) 由 GET /api/actions 恢复';
    },
    { label: 'e1-refresh-confirm' },
  );

  const red = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposer(page);
      await waitForMfaCard(page);
      return 'RED 转账挂起 → 同一 context reload → MfaCard(身份验证) 恢复';
    },
    { label: 'e2-refresh-mfa' },
  );

  return `YELLOW：${yellow} ｜ RED：${red}`;
}

interface Journey {
  name: string;
  run: (browser: Browser, baseUrl: string) => Promise<string>;
}

const JOURNEYS: readonly Journey[] = [
  { name: 'a-transfer-confirm', run: journeyTransferConfirm },
  { name: 'b-transfer-mfa', run: journeyTransferMfa },
  { name: 'c-plan-pause-resume', run: journeyPlanPauseResume },
  { name: 'd-plan-cancel', run: journeyPlanCancel },
  { name: 'e-refresh-action-recovery', run: journeyRefreshRecovery },
];

// --- entry point --------------------------------------------------------------------------------

async function main(): Promise<void> {
  const reporter = createReporter();
  let browser: Browser | undefined;
  let devServer: DevServer | undefined;
  let cleanedUp = false;

  // Idempotent, synchronous teardown — safe from a `process.on('exit')` handler. Kills the dev
  // server's WHOLE process tree (so no `next dev` is ever left listening) and closes the browser.
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (devServer) {
      try {
        devServer.stop();
      } catch {
        /* best-effort */
      }
    }
    setActiveBrowser(undefined);
    if (browser) {
      void browser.close().catch(() => undefined);
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (error) => {
    console.error(`未捕获异常：${errText(error)}`);
    cleanup();
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error(`未处理的 rejection：${errText(error)}`);
    cleanup();
    process.exit(1);
  });

  console.log('== AI Banking Agent 真实浏览器端到端验收 (tests/e2e) ==');

  let started = 0;
  try {
    const executablePath = resolveBrowserExecutable();
    if (executablePath === undefined) {
      // No real browser on this machine — SKIP honestly (never fake a pass, never fail the run).
      for (const journey of JOURNEYS) {
        reporter.skip(journey.name, '未找到真实浏览器（Chrome/Edge）；可设置 E2E_BROWSER_PATH 覆盖');
      }
    } else {
      const port = await pickFreePort();
      devServer = startDevServer(port);
      const baseUrl = devServer.baseUrl;
      console.log(`· next dev (pid=${devServer.pid}) → ${baseUrl}`);
      await waitForHealth(baseUrl, { output: devServer.output });
      console.log('· /api/health 就绪（LLM_MODE=mock）');

      console.log(`· 真实浏览器：${executablePath}`);
      browser = await launchBrowser(executablePath);
      setActiveBrowser(browser);

      for (const journey of JOURNEYS) {
        await runJourney(reporter, journey.name, (active) => journey.run(active, baseUrl));
        started += 1;
      }
    }
  } catch (error) {
    // Infrastructure failure (boot / health / browser launch): every journey not yet reported is
    // honestly FAILED with the concrete reason — no silent pass.
    const reason = `基础设施失败：${errText(error)}`;
    console.error(`· ${reason}`);
    for (const journey of JOURNEYS.slice(started)) {
      reporter.fail(journey.name, reason);
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* best-effort */
      }
      browser = undefined;
    }
    cleanup();
  }

  console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`入口脚本失败：${errText(error)}`);
  process.exitCode = 1;
});
