import { expect } from '@playwright/test';

export async function openTerminal(page) {
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(async () => (await import('/assets/terminal-boot.js')).terminal.state?.status),
    )
    .toBe('active');
  await expect(page.locator('#retry-button')).toBeHidden();
}

export async function readTerminal(page) {
  return page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    return {
      state: terminal.state,
      token: terminal.token,
      camera: terminal.field.camera.snapshot(),
    };
  });
}

export async function assign(page, mode = 'quota', difficulty = 'normal') {
  await page.locator('#assignment-button').click();
  await page.locator('#new-mode').selectOption(mode);
  await page.locator('#new-difficulty').selectOption(difficulty);
  await page.locator('#new-file').fill('Browser Verification');
  await page.locator('#start-button').click();
  await expect(page.locator('#terminal-dialog')).not.toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('Browser Verification');
}

export async function centerCluster(page) {
  await page.mouse.move(0, 0);
  return page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    const cluster = terminal.state.world.clusters.find((item) => item.active && item.slot >= 35);
    const cell = cluster.cells[Math.floor(cluster.cells.length / 2)];
    terminal.field.motion = null;
    terminal.field.camera.restore({
      x: ((cell % 256) + 0.5) * 36,
      y: (Math.floor(cell / 256) + 0.5) * 42,
      zoom: 1,
    });
    terminal.renderCamera();
    const point = terminal.field.basePosition(cell, performance.now());
    return { cluster, point, values: cluster.cells.map((id) => terminal.field.value(id)) };
  });
}

export async function ordinaryPoint(page) {
  await page.mouse.move(0, 0);
  return page.evaluate(async () => {
    const { terminal } = await import('/assets/terminal-boot.js');
    terminal.field.motion = null;
    const occupied = new Set(terminal.state.world.clusters.flatMap((cluster) => cluster.cells));
    let cell = 80 * 256 + 128;
    while (occupied.has(cell)) cell++;
    terminal.field.camera.restore({
      x: ((cell % 256) + 0.5) * 36,
      y: (Math.floor(cell / 256) + 0.5) * 42,
      zoom: 1,
    });
    terminal.renderCamera();
    return terminal.field.basePosition(cell, performance.now());
  });
}

export async function settleTransaction(page, revision) {
  await expect.poll(async () => (await readTerminal(page)).state.revision).toBe(revision);
}

export async function applyEnvelope(page, envelope) {
  await page.evaluate(async (data) => {
    const { terminal } = await import('/assets/terminal-boot.js');
    terminal.applyState(data);
  }, envelope);
}
