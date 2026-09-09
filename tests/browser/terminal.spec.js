import { test, expect } from '@playwright/test';
import {
  openTerminal,
  readTerminal,
  assign,
  centerCluster,
  ordinaryPoint,
  settleTransaction,
  applyEnvelope,
} from './support.js';

test('the full-screen terminal paints a dense, moving, irregular 40,960-number world', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openTerminal(page);
  await expect(page.locator('.bin')).toHaveCount(5);
  const metrics = await page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    const { field } = terminal;
    const bounds = field.camera.visibleBounds();
    field.draw(performance.now());
    const rectangle = field.canvas.getBoundingClientRect();
    const sizes = [
      ...new Set(terminal.state.world.clusters.map((cluster) => cluster.cells.length)),
    ];
    return {
      count: field.visibleCount,
      expected: (bounds.right - bounds.left) * (bounds.bottom - bounds.top),
      total: field.world.columns * field.world.rows,
      rectangle: {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      },
      viewport: { width: innerWidth, height: innerHeight },
      sizes,
      moving: field.basePosition(1234, 0).x !== field.basePosition(1234, 1000).x,
      background: getComputedStyle(document.body).backgroundColor,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(metrics.count).toBe(metrics.expected);
  expect(metrics.count).toBeGreaterThan(200);
  expect(metrics.count).toBeLessThan(40960);
  expect(metrics.total).toBe(40960);
  expect(metrics.rectangle).toEqual({ x: 0, y: 0, ...metrics.viewport });
  expect(metrics.sizes.length).toBeGreaterThan(8);
  expect(Math.min(...metrics.sizes)).toBeGreaterThanOrEqual(3);
  expect(Math.max(...metrics.sizes)).toBeLessThanOrEqual(18);
  expect(metrics.moving).toBe(true);
  expect(metrics.overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('pointer-anchored zoom, dragging, and reload preserve the explored zone', async ({ page }) => {
  await openTerminal(page);
  const viewport = page.viewportSize();
  // Browser wheel coordinates are device-rounded; use integral CSS coordinates on both projects.
  const point = { x: Math.round(viewport.width * 0.4), y: Math.round(viewport.height * 0.45) };
  const before = await page.evaluate(
    async (p) =>
      (await import('/assets/terminal-boot.js')).terminal.field.camera.screenToWorld(p.x, p.y),
    point,
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -240);
  await expect(page.locator('#zoom-label')).not.toHaveText('100%');
  const after = await page.evaluate(
    async (p) =>
      (await import('/assets/terminal-boot.js')).terminal.field.camera.screenToWorld(p.x, p.y),
    point,
  );
  expect(after.x).toBeCloseTo(before.x, 4);
  expect(after.y).toBeCloseTo(before.y, 4);
  const zoomed = (await readTerminal(page)).camera;
  await page.mouse.down();
  await page.mouse.move(point.x + 90, point.y + 60, { steps: 5 });
  await page.mouse.up();
  const dragged = await readTerminal(page);
  expect(dragged.camera.x).toBeLessThan(zoomed.x);
  expect(dragged.camera.y).toBeLessThan(zoomed.y);
  expect(dragged.state.revision).toBe(0);
  await page.reload();
  await expect.poll(async () => (await readTerminal(page)).state?.id).toBe(dragged.state.id);
  expect((await readTerminal(page)).camera).toEqual(dragged.camera);
});

test('a real mouse gathers for 1.5 seconds, ignores early clicks, and sends refilled digits to their bin', async ({
  page,
}) => {
  await openTerminal(page);
  await assign(page, 'quota', 'quarter_refiner');
  const target = await centerCluster(page);
  await page.mouse.move(target.point.x, target.point.y);
  await expect(page.locator('#feedback')).toContainText('IDENTIFYING');
  await page.mouse.click(target.point.x, target.point.y);
  expect((await readTerminal(page)).state.revision).toBe(0);
  expect((await readTerminal(page)).state.mistakes).toBe(0);
  await expect(page.locator('#feedback')).toContainText('CLICK TO REFINE', { timeout: 3000 });
  const response = page.waitForResponse('**/api/v2/capture');
  await page.mouse.click(target.point.x, target.point.y);
  expect((await (await response).json()).feedback.accepted).toBe(true);
  await settleTransaction(page, 1);
  const after = await readTerminal(page);
  expect(after.state.score).toBe(target.cluster.points);
  expect(after.state.bins[target.cluster.bin - 1].count).toBe(target.cluster.cells.length);
  await expect(page.locator(`#bin-count-${target.cluster.bin}`)).toContainText(
    String(target.cluster.cells.length).padStart(3, '0'),
  );
  const rendered = await page.evaluate(async (cells) => {
    const { field } = (await import('/assets/terminal-boot.js')).terminal;
    field.draw(performance.now());
    const bounds = field.camera.visibleBounds();
    return {
      values: cells.map((id) => field.value(id)),
      active: cells.some((id) => field.clusterCells.has(id)),
      count: field.visibleCount,
      expected: (bounds.right - bounds.left) * (bounds.bottom - bounds.top),
      flights: field.particles.length,
    };
  }, target.cluster.cells);
  expect(rendered.values.every((value, index) => value !== target.values[index])).toBe(true);
  expect(rendered.active).toBe(false);
  expect(rendered.count).toBe(rendered.expected);
  expect(rendered.flights).toBe(target.cluster.cells.length);
  const replacement = after.state.world.clusters.find(
    (cluster) => cluster.slot === target.cluster.slot,
  );
  expect(replacement.generation).toBe(target.cluster.generation + 1);
  expect(replacement.cells.some((id) => target.cluster.cells.includes(id))).toBe(false);
  await page.reload();
  await expect
    .poll(async () => (await readTerminal(page)).state?.score)
    .toBe(target.cluster.points);
  const savedValues = await page.evaluate(async (cells) => {
    const { terminal } = await import('/assets/terminal-boot.js');
    return cells.map((id) => terminal.field.value(id));
  }, target.cluster.cells);
  expect(savedValues).toEqual(rendered.values);
});

test('moving away releases a gathered cluster without a capture or penalty', async ({ page }) => {
  await openTerminal(page);
  const target = await centerCluster(page);
  await page.mouse.move(target.point.x, target.point.y);
  await expect(page.locator('#feedback')).toContainText('IDENTIFYING');
  await page.mouse.move(0, 0);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await import('/assets/terminal-boot.js')).terminal.field.motion === null,
      ),
    )
    .toBe(true);
  expect((await readTerminal(page)).state.revision).toBe(0);
});

test('all gameplay modes and independent difficulty options open real assignments', async ({
  page,
}) => {
  await openTerminal(page);
  const modes = ['quota', 'timed', 'endless'];
  const difficulties = ['normal', 'quota_achiever', 'quarter_refiner'];
  for (let index = 0; index < modes.length; index++) {
    await assign(page, modes[index], difficulties[index]);
    const { state } = await readTerminal(page);
    expect(state.mode).toBe(modes[index]);
    expect(state.difficulty).toBe(difficulties[index]);
    expect(state.status).toBe('active');
    if (state.mode === 'timed')
      await expect(page.locator('#run-clock')).toHaveText(/^(15:00|14:59)$/);
    else await expect(page.locator('#run-clock')).toHaveText('UNTIMED');
  }
});

test('normal ordinary clicks are harmless and quota achiever deducts at most 50 points', async ({
  page,
  request,
}) => {
  await openTerminal(page);
  let point = await ordinaryPoint(page);
  await page.mouse.click(point.x, point.y);
  await settleTransaction(page, 1);
  expect((await readTerminal(page)).state.score).toBe(0);
  expect((await readTerminal(page)).state.mistakes).toBe(0);
  await assign(page, 'quota', 'quota_achiever');
  let run = await readTerminal(page);
  const cluster = run.state.world.clusters.find((item) => item.points > 50);
  const earned = await (
    await request.post('/api/v2/capture', { data: { token: run.token, cluster_id: cluster.id } })
  ).json();
  await applyEnvelope(page, earned);
  point = await ordinaryPoint(page);
  await page.mouse.click(point.x, point.y);
  await settleTransaction(page, 2);
  run = await readTerminal(page);
  expect(run.state.score).toBe(cluster.points - 50);
  expect(run.state.mistakes).toBe(0);
  for (let revision = 3; revision <= 6; revision++) {
    point = await ordinaryPoint(page);
    await page.mouse.click(point.x, point.y);
    await settleTransaction(page, revision);
  }
  expect((await readTerminal(page)).state.score).toBe(0);
  expect((await readTerminal(page)).state.status).toBe('active');
});

test('the third ordinary-number strike ends the shift and archives it once', async ({ page }) => {
  await openTerminal(page);
  await assign(page, 'quota', 'quarter_refiner');
  for (let strike = 1; strike <= 3; strike++) {
    const point = await ordinaryPoint(page);
    await page.mouse.click(point.x, point.y);
    await settleTransaction(page, strike);
    expect((await readTerminal(page)).state.mistakes).toBe(strike);
  }
  await expect(page.locator('#result-panel')).toBeVisible();
  await expect(page.locator('#result-summary')).toContainText('THIS SHIFT HAS ENDED');
  await page.locator('#close-dialog').click();
  await page.locator('#history-button').click();
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await expect(page.locator('#history-list')).toContainText('failed');
  await page.reload();
  await expect(page.locator('#result-panel')).toBeVisible();
  await page.locator('#close-dialog').click();
  await page.locator('#history-button').click();
  await expect(page.locator('#history-list li')).toHaveCount(1);
});

test('keyboard navigation focuses only a visible signal and Enter refines it', async ({ page }) => {
  await openTerminal(page);
  await centerCluster(page);
  await page.locator('#number-field').focus();
  const before = (await readTerminal(page)).camera;
  await page.keyboard.press('ArrowRight');
  expect((await readTerminal(page)).camera.x).toBeGreaterThan(before.x);
  await page.keyboard.press('f');
  await expect(page.locator('#feedback')).toContainText(/IDENTIFYING|Visible signal/i);
  await page.keyboard.press('Enter');
  expect((await readTerminal(page)).state.revision).toBe(0);
  await expect(page.locator('#feedback')).toContainText('CLICK TO REFINE', { timeout: 3000 });
  await page.keyboard.press('Enter');
  await settleTransaction(page, 1);
  expect((await readTerminal(page)).state.score).toBeGreaterThan(0);
});

test('touch hold gathers and release refines while two-finger pinch navigates without mistakes', async ({
  page,
}) => {
  await openTerminal(page);
  const target = await centerCluster(page);
  await page.evaluate(async (point) => {
    const { terminal } = await import('/assets/terminal-boot.js');
    // Synthetic pointer IDs are not active browser pointers, so bypass native capture only here.
    terminal.canvas.setPointerCapture = () => {};
    terminal.canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 11,
        pointerType: 'touch',
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
      }),
    );
  }, target.point);
  await expect(page.locator('#feedback')).toContainText('CLICK TO REFINE', { timeout: 3000 });
  await page.locator('#number-field').dispatchEvent('pointerup', {
    pointerId: 11,
    pointerType: 'touch',
    clientX: target.point.x,
    clientY: target.point.y,
  });
  await settleTransaction(page, 1);
  const before = (await readTerminal(page)).camera;
  await page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    const events = [
      ['pointerdown', 21, 120, 350],
      ['pointerdown', 22, 220, 350],
      ['pointermove', 22, 270, 370],
      ['pointerup', 21, 120, 350],
      ['pointerup', 22, 270, 370],
    ];
    for (const [type, pointerId, clientX, clientY] of events)
      terminal.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          clientX,
          clientY,
          bubbles: true,
        }),
      );
  });
  const after = await readTerminal(page);
  expect(after.camera.zoom).toBeGreaterThan(before.zoom);
  expect(after.camera.x).not.toBe(before.x);
  expect(after.state.revision).toBe(1);
});

for (const mode of ['quota', 'endless']) {
  test(`${mode} fills every bin through the real API and ${mode === 'quota' ? 'closes the file' : 'starts a new cycle'}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    await openTerminal(page);
    await assign(page, mode);
    let envelope = await readTerminal(page);
    let captures = 0;
    while (envelope.state.status === 'active' && envelope.state.cycle === 1 && captures < 180) {
      const cluster = envelope.state.world.clusters.find((item) => item.active);
      const response = await request.post('/api/v2/capture', {
        data: { token: envelope.token, cluster_id: cluster.id },
      });
      expect(response.ok()).toBe(true);
      envelope = await response.json();
      expect(envelope.feedback.accepted).toBe(true);
      captures++;
    }
    expect(captures).toBeLessThan(180);
    expect(envelope.token.length).toBeLessThan(8192);
    await applyEnvelope(page, envelope);
    if (mode === 'quota') {
      expect(envelope.state.status).toBe('completed');
      expect(envelope.state.bins.every((bin) => bin.count === 100)).toBe(true);
      await expect(page.locator('#completion')).toHaveText('100% COMPLETE');
      await expect(page.locator('#result-summary')).toContainText('QUOTA MET');
    } else {
      expect(envelope.state.status).toBe('active');
      expect(envelope.state.cycle).toBe(2);
      expect(envelope.state.bins.every((bin) => bin.count === 0)).toBe(true);
      await expect(page.locator('#assignment-label')).toContainText('CYCLE 2');
      await expect(page.locator('#terminal-dialog')).not.toBeVisible();
    }
  });
}

test('interrupted capture preserves the signed file and explicit retry completes once', async ({
  page,
}) => {
  await openTerminal(page);
  const target = await centerCluster(page);
  const previous = await readTerminal(page);
  await page.route('**/api/v2/capture', (route) => route.abort('failed'));
  await page.mouse.move(target.point.x, target.point.y);
  await expect(page.locator('#feedback')).toContainText('CLICK TO REFINE', { timeout: 3000 });
  await page.mouse.click(target.point.x, target.point.y);
  await expect(page.locator('#retry-button')).toBeVisible();
  const failed = await readTerminal(page);
  expect(failed.token).toBe(previous.token);
  expect(failed.state.revision).toBe(0);
  await page.unroute('**/api/v2/capture');
  await page.locator('#retry-button').click();
  await settleTransaction(page, 1);
  await expect(page.locator('#retry-button')).toBeHidden();
  expect((await readTerminal(page)).state.score).toBe(target.cluster.points);
});

test('terminal preferences survive reload without replacing a legacy save', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mdr.session'))
      localStorage.setItem('mdr.session', 'legacy-signed-file');
  });
  await openTerminal(page);
  await page.locator('#settings-button').click();
  await page.locator('#motion-setting').check();
  await page.locator('#sound-setting').check();
  await page.locator('#close-dialog').click();
  await page.reload();
  await expect.poll(async () => (await readTerminal(page)).state?.status).toBe('active');
  await page.locator('#settings-button').click();
  await expect(page.locator('#motion-setting')).toBeChecked();
  await expect(page.locator('#sound-setting')).toBeChecked();
  const saved = await page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    return {
      original: localStorage.getItem('mdr.session'),
      backup: localStorage.getItem('mdr.legacy-session'),
      stationary: terminal.field.basePosition(5, 0).x === terminal.field.basePosition(5, 4000).x,
    };
  });
  expect(saved).toEqual({
    original: 'legacy-signed-file',
    backup: 'legacy-signed-file',
    stationary: true,
  });
});

test('an expired countdown requests authoritative state and displays the ended shift', async ({
  page,
}) => {
  await openTerminal(page);
  await assign(page, 'timed');
  const envelope = await readTerminal(page);
  envelope.state.status = 'failed';
  envelope.state.remaining_seconds = 0;
  envelope.state.elapsed_seconds = 900;
  envelope.state.world.clusters.forEach((cluster) => {
    cluster.active = false;
  });
  // Server-side clock/expiry validation is covered separately; this checks the browser boundary.
  await page.route('**/api/v2/restore', (route) => route.fulfill({ json: envelope }));
  const restored = page.waitForRequest('**/api/v2/restore');
  await page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    terminal.receivedAt = performance.now() - 901000;
    terminal.renderClock(performance.now());
  });
  await restored;
  await expect(page.locator('#run-clock')).toHaveText('00:00');
  await expect(page.locator('#result-panel')).toBeVisible();
  expect((await readTerminal(page)).state.status).toBe('failed');
});
