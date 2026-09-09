import { test, expect } from '@playwright/test';
import { openTerminal, readTerminal } from './support.js';

test('renderer culls at every zoom and stays bounded during repeated drawing', async ({
  page,
}, info) => {
  await openTerminal(page);
  const samples = await page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    const { field } = terminal;
    const results = [];
    for (const zoom of [0.5, 1, 3]) {
      field.camera.restore({ x: 4608, y: 3360, zoom });
      const bounds = field.camera.visibleBounds();
      const started = performance.now();
      for (let frame = 0; frame < 30; frame++) field.draw(started + frame * 17);
      results.push({
        zoom,
        count: field.visibleCount,
        expected: (bounds.right - bounds.left) * (bounds.bottom - bounds.top),
        meanMs: (performance.now() - started) / 30,
      });
    }
    field.camera.restore({ x: 4608, y: 3360, zoom: 1 });
    terminal.renderCamera();
    return results;
  });
  for (const sample of samples) {
    expect(sample.count).toBe(sample.expected);
    expect(sample.count).toBeLessThan(7000);
    expect(sample.meanMs).toBeLessThan(100); // Gross-regression guard, not a device FPS guarantee.
  }
  expect(samples[0].count).toBeGreaterThan(samples[1].count);
  expect(samples[1].count).toBeGreaterThan(samples[2].count);
  info.annotations.push({ type: 'render-benchmark', description: JSON.stringify(samples) });
  await page.screenshot({ path: info.outputPath('terminal-v2.png') });
});

test('a failed new file stays visible inside its dialog and preserves the confirmed save', async ({
  page,
}) => {
  await openTerminal(page);
  const previous = await readTerminal(page);
  await page.locator('#assignment-button').click();
  await page.locator('#new-file').fill('Recovered Connection');
  await page.route('**/api/v2/session', (route) => route.abort('failed'));
  await page.locator('#start-button').click();
  await expect(page.locator('#dialog-feedback')).toContainText('connection interrupted');
  await expect(page.locator('#terminal-dialog')).toBeVisible();
  expect((await readTerminal(page)).token).toBe(previous.token);
  expect((await readTerminal(page)).state.id).toBe(previous.state.id);
  await page.unroute('**/api/v2/session');
  await page.locator('#start-button').click();
  await expect(page.locator('#terminal-dialog')).not.toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('Recovered Connection');
  expect((await readTerminal(page)).state.id).not.toBe(previous.state.id);
});
