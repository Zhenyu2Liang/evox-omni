import type { Page } from 'playwright-core';
import type { ScheduleInbox } from '../../lib/contracts/schedule';
import { demoNow } from '../../lib/clock';
import { withDb, writeScenarioEvidence } from './live-virtual-card.e2e-helper';
import { SELECTORS, clickConfirm, fetchDashboardSummary, fetchLedger, getJson, gotoAgent,
  submitChat, waitFor, waitForConfirmCard, waitForElementHydration } from './helpers';

interface Params {
  page: Page;
  baseUrl: string;
  captureShot(page: Page, label: string): Promise<string | undefined>;
}

/** A real-model reminder stays in the business future despite the machine's later wall clock. */
export async function scenarioScheduleBusinessClock({ page, baseUrl, captureShot }: Params): Promise<string> {
  const name = '电费业务时钟核查';
  const businessTime = demoNow();
  const runAt = businessTime + 60_000;
  const local = new Date(runAt + 8 * 3600_000).toISOString().slice(0, 16);
  const initial = await getJson<ScheduleInbox>(`${baseUrl}/api/schedules`);
  const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
  const ledger = await fetchLedger(baseUrl);
  await gotoAgent(page, baseUrl);
  const prompt = `请在北京时间${local.replace('T', ' ')}提醒我缴纳电费，名称为${name}。只创建提醒，不转账，请发起并等待我确认。`;
  await submitChat(page, prompt);
  await waitForConfirmCard(page, 90_000);
  const dock = page.locator(SELECTORS.approvalRequest);
  const actionId = await dock.getAttribute('data-action-id');
  if (!actionId) throw new Error('The reminder confirmation has no original action identity');
  await clickConfirm(page);
  await waitFor(async () => await dock.count() === 0 && await page.locator(SELECTORS.composer).isEnabled(),
    { timeoutMs: 120_000, description: 'The confirmed reminder is saved' });
  let inbox = await getJson<ScheduleInbox>(`${baseUrl}/api/schedules`);
  const created = inbox.tasks.filter(task => task.name === name);
  if (created.length !== 1 || created[0].runAt !== runAt || created[0].status !== 'SCHEDULED') {
    throw new Error(`The reminder did not preserve its requested future time: ${JSON.stringify(created)}`);
  }
  const taskId = created[0].id;
  await page.goto(`${baseUrl}/schedules`, { waitUntil: 'networkidle' });
  await waitForElementHydration(page, 'main button');
  const tick = async () => {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/schedules/tick');
    await page.getByRole('button', { name: '检查到期任务', exact: true }).click();
    const envelope = await (await response).json();
    if (!envelope.ok || envelope.data.evaluatedAt !== businessTime) throw new Error(`Default dispatch clock differs from creation: ${JSON.stringify(envelope)}`);
    await waitFor(async () => await page.getByRole('button', { name: '检查到期任务', exact: true }).isEnabled(),
      { description: 'The schedule page completes its reload' });
    return envelope.data;
  };
  const beforeDue = await tick();
  inbox = await getJson<ScheduleInbox>(`${baseUrl}/api/schedules`);
  if (beforeDue.dispatches.length || inbox.tasks.find(task => task.id === taskId)?.status !== 'SCHEDULED' ||
      inbox.notifications.length !== initial.notifications.length) throw new Error('A business-future reminder or unrelated seed was dispatched early');
  const futureShot = await captureShot(page, 'lK-business-future-not-dispatched');

  // Test-only time travel affects this new isolated row; the public request still cannot supply now.
  await withDb(async db => {
    await db.scheduledTask.update({ where: { id: taskId }, data: { runAt: new Date(businessTime) } });
  });
  await tick();
  await tick();
  inbox = await getJson<ScheduleInbox>(`${baseUrl}/api/schedules`);
  const notes = inbox.notifications.filter(note => note.scheduledTaskId === taskId);
  if (inbox.tasks.find(task => task.id === taskId)?.status !== 'DONE' || notes.length !== 1 || notes[0].createdAt !== businessTime) {
    throw new Error(`The due reminder was not delivered exactly once at business time: ${JSON.stringify(notes)}`);
  }
  for (const task of initial.tasks) {
    if (inbox.tasks.find(row => row.id === task.id)?.status !== task.status) throw new Error(`Unrelated seed task ${task.id} changed`);
  }
  if ((await fetchDashboardSummary(baseUrl)).checkingBalance !== balance ||
      JSON.stringify((await fetchLedger(baseUrl)).transactions) !== JSON.stringify(ledger.transactions)) throw new Error('A reminder changed account money');
  const deliveredShot = await captureShot(page, 'lK-business-due-delivered-once');
  const evidence = writeScenarioEvidence('lK-schedule-business-clock', {
    prompt, actionId, taskId, businessTime, realTime: Date.now(), requestedRunAt: runAt, beforeDue,
    notification: notes[0], balance, originalSeedsUnchanged: true, screenshots: [futureShot, deliveredShot],
  });
  return `Real model created ${taskId}; business future ${local} was not dispatched; due fixture delivered once at ${businessTime}; seeds, balance and ledger unchanged. Evidence ${evidence}`;
}
