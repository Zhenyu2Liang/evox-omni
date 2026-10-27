import type { Browser, Locator } from 'playwright-core';
import { captureScreenshot, fetchLedger, gotoAgent, SELECTORS, submitChat, waitFor, withPage } from './helpers';

/** Resolve alpha and theme-dependent CSS colours before comparing against the rendered surface. */
async function contrast(locator: Locator, property: 'color' | 'borderColor' | 'outlineColor' = 'color') {
  return locator.evaluate((el, property) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const parents: Element[] = [];
    for (let current: Element | null = el; current; current = current.parentElement) parents.unshift(current);
    const colours = parents.map(parent => getComputedStyle(parent).backgroundColor).concat(getComputedStyle(el)[property]);
    let background = [255, 255, 255];
    let foreground = background;
    for (let index = 0; index < colours.length; index++) {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = colours[index]; ctx.fillRect(0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      const alpha = pixel[3] / 255;
      const composite = [0, 1, 2].map(channel => pixel[channel] * alpha + background[channel] * (1 - alpha));
      if (index === colours.length - 1) foreground = composite;
      else background = composite;
    }
    const [a, b] = [foreground, background].map(colour => colour.reduce((sum, value, index) => {
      value /= 255;
      return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
    }, 0));
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  }, property);
}

async function assertInput(input: Locator) {
  if (await contrast(input, 'borderColor') < 3) throw new Error('An input boundary is still difficult to distinguish');
  await input.focus();
  if (await input.evaluate(el => getComputedStyle(el).outlineStyle) === 'none' || await contrast(input, 'outlineColor') < 3) throw new Error('An input has no clear focus indicator');
}

async function financialText(card: Locator) {
  return card.evaluate(el => {
    const copy = el.cloneNode(true) as HTMLElement;
    // Responsive charts intentionally vary their axis-label stride; compare all non-chart facts.
    copy.querySelectorAll('svg, [role="tooltip"]').forEach(node => node.remove());
    return copy.textContent?.replace(/\s+/g, ' ').trim();
  });
}

/** Test actual rendered spending/anomaly cards instead of only checking a palette helper. */
export async function journeyReadability(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.context().addCookies([{ name: 'banking_theme', value: 'dark', url: baseUrl }]);
    await page.setViewportSize({ width: 1440, height: 960 });
    const ledger = JSON.stringify(await fetchLedger(baseUrl));
    await gotoAgent(page, baseUrl);
    if (await page.locator('aside [data-brand-link] span span').last().evaluate(el => getComputedStyle(el).fontSize) !== '11px') throw new Error('The English brand is not 11px');
    await submitChat(page, '分析这个月的消费');
    const spending = page.locator('[data-chat-card-type="spending"]').last();
    await spending.waitFor();
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Spending analysis settled' });
    const spendingFacts = await financialText(spending);
    await submitChat(page, '帮我看有没有异常消费');
    const anomaly = page.locator('[data-chat-card-type="anomaly"]').last();
    await anomaly.waitFor();
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Anomaly analysis settled' });
    const anomalyFacts = await financialText(anomaly);

    for (const theme of ['dark', 'light']) {
      await page.locator('[data-theme-switcher]:visible').selectOption(theme);
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
        const expectedBody = width >= 640 ? '15px' : '16px';
        const text = page.locator('[data-assistant-content]').last();
        if (await text.evaluate(el => getComputedStyle(el).fontSize) !== expectedBody) throw new Error(`Chat text is not ${expectedBody} at ${width}`);
        const name = page.locator('[data-message-role="assistant"] > div > p').last();
        if (await name.evaluate(el => getComputedStyle(el).fontSize) !== '12px') throw new Error('The speaker label is still too small');
        for (const card of [spending, anomaly]) {
          const labels = card.locator('.text-banking-navy:not(.rounded-full)');
          for (let index = 0; index < await labels.count(); index++) {
            const label = labels.nth(index);
            if (!await label.isVisible()) continue;
            const size = await label.evaluate(el => getComputedStyle(el).fontSize);
            const ratio = await contrast(label);
            if (parseFloat(size) < 13 || ratio < 4.5) throw new Error(`Financial label ${JSON.stringify(await label.innerText())}: ${size}, contrast ${ratio.toFixed(2)}; ${await label.getAttribute('class')}`);
          }
          await card.scrollIntoViewIfNeeded();
          if (await card.evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error(`The larger financial card text overflows at ${width}`);
        }
        const success = page.locator('[data-tool-status="success"] > span').first();
        if (await contrast(success) < 3) throw new Error('The success check is still difficult to see');
        const badge = anomaly.locator('span.rounded-full.text-xs').first();
        if (await badge.evaluate(el => getComputedStyle(el).fontSize) !== '12px') throw new Error('Status badges were enlarged with descriptive text');
        if (await financialText(spending) !== spendingFacts || await financialText(anomaly) !== anomalyFacts) throw new Error('Appearance or typography altered non-chart financial facts');
        await captureScreenshot(page, `readability-${theme}-${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 960 });
    }
    // Check real form controls in both themes, without submitting any form.
    for (const theme of ['light', 'dark']) {
      await page.locator('[data-theme-switcher]:visible').selectOption(theme);
      for (const route of ['contacts', 'security', 'bills', 'cards']) {
        await page.goto(`${baseUrl}/${route}`, { waitUntil: 'networkidle' });
        if (route === 'security') await page.locator('[data-unlock-guidance] summary').click();
        if (route === 'cards') {
          await page.locator('[data-card-consume] button:enabled').first().click();
          await page.locator('dialog[open]').waitFor();
        }
        const inputs = page.locator('main .bank-input:visible, dialog[open] .bank-input:visible');
        if (!await inputs.count()) throw new Error(`No input was checked on ${route}`);
        for (let index = 0; index < await inputs.count(); index++) await assertInput(inputs.nth(index));
        await captureScreenshot(page, `readability-${theme}-${route}-fields`);
        if (route === 'cards') await page.keyboard.press('Escape');
      }
    }
    if (JSON.stringify(await fetchLedger(baseUrl)) !== ledger) throw new Error('Readability checks changed funds or ledger records');
    if (errors.length) throw new Error(errors.join('; '));
    return 'Real spending/anomaly cards, 15px desktop and 16px phone dialogue, 13px captions, 11px brand and 12px badges passed in both themes; success glyph and form boundary/focus contrast passed; financial facts and ledger unchanged.';
  }, { label: 'typography-and-dark-contrast' });
}
