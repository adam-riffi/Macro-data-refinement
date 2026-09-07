import { test, expect } from '@playwright/test';

test('terminal loads cleanly with accessible controls and responsive layout', async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  await expect(page.locator('#connection-label')).toHaveText('SYSTEM CONNECTED');
  await expect(page.locator('#file-progress')).toHaveText('0%');
  await expect(page.locator('#bin-1')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `artifacts/terminal-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.locator('#help-button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#modal-content')).toContainText('Orientation');
  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('a successful refinement survives reload and a wrong bin records a strike', async ({
  page,
}) => {
  const first = page.waitForResponse('/api/session');
  await page.goto('/');
  const { state } = await (await first).json();
  const cluster = state.board.clusters[0];
  await page.locator(`[data-cell="${cluster.cells[0]}"]`).click();
  await expect(page.locator('.number-cell.is-selected')).toHaveCount(4);
  await expect(page.locator('#selection-detail')).toContainText(`bin 0${cluster.bin}`);
  await page.locator(`#bin-${cluster.bin}`).click();
  await expect(page.locator('#file-progress')).toHaveText('5%');
  await expect(page.locator('#score-value')).toHaveText('0100');
  await expect(page.locator('#toast')).toBeVisible();
  const restored = page.waitForResponse('/api/restore');
  await page.reload();
  const data = await (await restored).json();
  await expect(page.locator('#file-progress')).toHaveText('5%');
  const next = data.state.board.clusters.find((item) => !item.collected);
  await page.locator(`[data-cell="${next.cells[0]}"]`).click();
  await page.locator(`#bin-${(next.bin % 5) + 1}`).click();
  await expect(page.locator('#mistakes-value')).toContainText('1 / 5');
  await expect(page.locator('#score-value')).toHaveText('0050');
});

test('all twenty groups complete a file and award an archived waffle party', async ({ page }) => {
  const first = page.waitForResponse('/api/session');
  await page.goto('/');
  let { state } = await (await first).json();
  for (let batch = 0; batch < 20; batch += 1) {
    const cluster = state.board.clusters.find((item) => !item.collected);
    await page.locator(`[data-cell="${cluster.cells[0]}"]`).click();
    const refined = page.waitForResponse('/api/refine');
    await page.locator(`#bin-${cluster.bin}`).click();
    ({ state } = await (await refined).json());
    await expect(page.locator('#file-progress')).toHaveText(`${(batch + 1) * 5}%`);
  }
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#modal-content')).toContainText('waffle party');
  await expect(page.locator('#score-value')).toHaveText('6750');
  await page.getByRole('button', { name: 'Review terminal' }).click();
  await page.locator('#archive-button').click();
  await expect(page.locator('.archive-row')).toHaveCount(1);
  await expect(page.locator('.archive-row')).toContainText('Cold Harbor');
  await expect(page.locator('.archive-row')).toContainText('6750');
  await page.reload();
  await expect(page.locator('#file-progress')).toHaveText('100%');
});

test('assignment choices implement orientation and overtime loss limits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  await page.locator('#new-file-button').click();
  await page.locator('#assignment-file').selectOption('Siena');
  await page.locator('#assignment-mode').selectOption('orientation');
  await page.getByRole('button', { name: 'Replace current file' }).click();
  await expect(page.locator('#file-name')).toHaveText('Siena');
  await expect(page.locator('#mode-label')).toHaveText(/orientation/i);
  await expect(page.locator('#mistakes-value')).toHaveText('0 / 8');
  await page.locator('#new-file-button').click();
  await page.locator('#assignment-mode').selectOption('overtime');
  await page.getByRole('button', { name: 'Replace current file' }).click();
  await expect(page.locator('#mode-label')).toHaveText(/overtime/i);
  for (let strike = 1; strike <= 3; strike += 1) {
    await page.locator('.number-cell:not(.is-anomaly)').first().click();
    await page.locator('#bin-1').click();
    await expect(page.locator('#mistakes-value')).toHaveText(`${strike} / 3`);
  }
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#modal-content')).toContainText('shift limit');
  await page.getByRole('button', { name: 'Review terminal' }).click();
  await expect(page.locator('#bin-1')).toBeDisabled();
});

test('scan, keyboard selection, shortcuts, and preferences work', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  await page.locator('#scan-button').click();
  await expect(page.locator('.is-scanned')).toHaveCount(4);
  await expect(page.locator('#scan-button')).toBeDisabled();
  const target = page.locator('.is-scanned').first();
  await target.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.number-cell.is-selected')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.locator('.number-cell.is-selected')).toHaveCount(0);
  await page.keyboard.press('Space');
  const label = await page.locator('#selection-detail').textContent();
  await page.keyboard.press(label.match(/bin 0(\d)/)[1]);
  await expect(page.locator('#file-progress')).toHaveText('5%');
  await page.locator('#settings-button').click();
  await page.locator('#preference-motion').check();
  await page.locator('#preference-sound').check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.locator('body')).toHaveClass(/reduced-motion/);
  await expect(page.locator('#sound-button')).toHaveText('SOUND ON');
  await page.reload();
  await expect(page.locator('#sound-button')).toHaveText('SOUND ON');
  await expect(page.locator('body')).toHaveClass(/reduced-motion/);
});

test('a network failure keeps the last save and allows retry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  const previousToken = await page.evaluate(() => localStorage.getItem('mdr.session'));
  await page.locator('.number-cell.is-anomaly').first().click();
  const label = await page.locator('#selection-detail').textContent();
  const bin = label.match(/bin 0(\d)/)[1];
  await page.route('**/api/refine', (route) => route.abort());
  await page.locator(`#bin-${bin}`).click();
  await expect(page.locator('#connection-label')).toHaveText('CONNECTION INTERRUPTED');
  await expect(page.locator('#toast')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mdr.session'))).toBe(previousToken);
  await page.unroute('**/api/refine');
  await page.locator(`#bin-${bin}`).click();
  await expect(page.locator('#file-progress')).toHaveText('5%');
  await expect(page.locator('#connection-label')).toHaveText('SYSTEM CONNECTED');
});

test('pointer rectangle isolates a cluster without selecting adjacent cells', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Touch devices select a cluster with a tap; desktop tests the rectangle gesture.',
  );
  const first = page.waitForResponse('/api/session');
  await page.goto('/');
  const { state } = await (await first).json();
  const cluster = state.board.clusters[0];
  const start = await page.locator(`[data-cell="${cluster.cells[0]}"]`).boundingBox();
  const end = await page.locator(`[data-cell="${cluster.cells[3]}"]`).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.number-cell.is-selected')).toHaveCount(4);
  await page.locator(`#bin-${cluster.bin}`).click();
  await expect(page.locator('#file-progress')).toHaveText('5%');
});

test('a failed first connection can reconnect without reloading the page', async ({ page }) => {
  await page.route('**/api/session', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#connection-label')).toHaveText('CONNECTION INTERRUPTED');
  await expect(page.locator('#retry-button')).toBeVisible();
  await expect(page.locator('#toast')).toBeVisible();
  await page.unroute('**/api/session');
  await page.locator('#retry-button').click();
  await expect(page.locator('.number-cell')).toHaveCount(200);
  await expect(page.locator('#connection-label')).toHaveText('SYSTEM CONNECTED');
  await expect(page.locator('#retry-button')).not.toBeVisible();
});

test('keyboard navigation reveals cells outside the visible number field', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.number-cell')).toHaveCount(200);
  await page.locator('[data-cell="0"]').focus();
  await page.keyboard.press('End');
  const cell = page.locator('[data-cell="19"]');
  await expect(cell).toBeFocused();
  const bounds = await cell.boundingBox();
  const field = await page.locator('.grid-scroll').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(field.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(field.x + field.width + 1);
});
