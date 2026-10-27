/** Real provider + real Chrome; only the dedicated E2E database is reset. */
import nextEnv from '@next/env';
import { journeyAssistantHelp } from './assistant-help.e2e-helper';
import { bootDevServer, getJson, launchBrowser, REPO_ROOT, resetDemoDatabase, resolveBrowserExecutable, useIsolatedDatabase } from './helpers';
import type { Browser } from 'playwright-core';
import type { DevServer } from './helpers';

let browser: Browser | undefined;
let server: DevServer | undefined;
function stopServer() { server?.stop(); server = undefined; }
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('SIGTERM', () => { stopServer(); process.exit(143); });

try {
  nextEnv.loadEnvConfig(REPO_ROOT, true, { info: () => undefined, error: () => { throw new Error('Could not load live configuration'); } });
  process.env.LLM_MODE = 'live';
  delete process.env.E2E_SKIP_DB_RESET;
  useIsolatedDatabase();
  resetDemoDatabase();
  const executable = resolveBrowserExecutable();
  if (!executable) throw new Error('Real Chrome or Edge is required for live onboarding acceptance');
  server = await bootDevServer();
  if ((await getJson<{ llmMode: string }>(`${server.baseUrl}/api/health`)).llmMode !== 'live') throw new Error('The test server is not in live mode');
  browser = await launchBrowser(executable);
  const result = await journeyAssistantHelp(browser, server.baseUrl, { exerciseModel: true });
  const { createDatabaseClient } = await import('../../lib/db/database');
  const db = createDatabaseClient();
  try {
    const requests = await db.modelRequest.findMany({ where: { status: 'completed' }, select: { id: true } });
    const rows = await db.agentRunEvent.findMany({ where: { eventType: { startsWith: 'provider_' } }, select: { eventType: true, payloadJson: true } });
    const evidence = rows.map(row => ({ type: row.eventType, ...JSON.parse(row.payloadJson) }));
    if (!requests.length || requests.some(request => {
      const events = evidence.filter(event => event.modelRequestId === request.id);
      return !events.some(event => event.type === 'provider_response_headers' && event.payload.status === 200) ||
        !events.some(event => event.type === 'provider_response_event' && event.payload.kind === 'transport_end' && event.payload.completed === true);
    })) throw new Error('Missing HTTP 200 and completed stream evidence for the real model query');
    console.log(`Real provider evidence: ${requests.length} completed model requests, HTTP 200 and completed streams.`);
  } finally { await db.$disconnect(); }
  console.log(`PASS live-assistant-help — ${result} A real read-only model query completed after onboarding.`);
} catch (error) {
  console.error(`FAIL live-assistant-help — ${error instanceof Error ? error.message : 'Unknown acceptance failure'}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  stopServer();
}
