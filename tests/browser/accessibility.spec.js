import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('terminal and preferences meet automated WCAG A/AA checks', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  const terminal = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    terminal.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
  await page.locator('#settings-button').click();
  const settings = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(settings.violations).toEqual([]);
});
