import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openTerminal } from './support.js';

test('canvas terminal and all utility overlays meet automated WCAG A/AA checks', async ({
  page,
}) => {
  test.setTimeout(60000);
  await openTerminal(page);
  const terminal = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    terminal.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
  for (const panel of ['settings', 'assignment', 'help', 'history']) {
    await page.locator(`#${panel}-button`).click();
    await expect(page.locator(`#${panel}-panel`)).toBeVisible();
    const overlay = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(overlay.violations, `${panel} overlay`).toEqual([]);
    await page.locator('#close-dialog').click();
    await expect(page.locator('#number-field')).toBeFocused();
  }
});
