import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AppError } from './errors';

let active = 0;
export function reportPdfBrowser(): string | undefined {
  const candidates = [process.env.BANKING_PDF_BROWSER_PATH, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

/** Render only host-authored offline HTML, with scripts and all network requests disabled. */
export async function billReportPdf(html: string): Promise<Uint8Array<ArrayBuffer>> {
  if (active >= 2) throw new AppError('LIMIT_EXCEEDED', 'PDF export is busy. Please retry.');
  const executablePath = reportPdfBrowser();
  if (!executablePath) throw new AppError('TOOL_FAILED', 'PDF export is unavailable. Export HTML or retry later.');
  active++;
  let browser;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, timeout: 10000 });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    await page.emulateMedia({ media: 'print' });
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PDF deadline exceeded')), 15000); });
    const bytes = await Promise.race([deadline, page.pdf({ preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;color:#786b63;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' })]);
    return new Uint8Array(bytes);
  } catch {
    throw new AppError('TOOL_FAILED', 'PDF export failed. Please retry or export HTML.');
  } finally { clearTimeout(timer); try { await browser?.close(); } finally { active--; } }
}
