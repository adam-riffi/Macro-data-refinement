import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Camera,
  ClusterMotion,
  NumberField,
  CELL_WIDTH,
  CELL_HEIGHT,
} from '../../public/assets/field.js';

const cluster = {
  id: '0:0',
  slot: 0,
  generation: 0,
  cells: [1000, 1001, 1257, 1513, 1514],
  bin: 1,
  points: 54,
  active: true,
};
function fixture() {
  const calls = [];
  const context = {
    setTransform(...a) {
      calls.push(['transform', ...a]);
    },
    fillRect(...a) {
      calls.push(['background', ...a]);
    },
    clearRect() {},
    fillText(...a) {
      calls.push(['digit', ...a]);
    },
    beginPath() {},
    arc() {},
    stroke() {},
  };
  const canvas = {
    getContext() {
      return context;
    },
  };
  const field = new NumberField(canvas, {
    effectsCanvas: {
      getContext() {
        return context;
      },
    },
  });
  field.resize(1000, 700, 2);
  field.setWorld({ seed: 17, columns: 256, rows: 160, clusters: [cluster] });
  field.camera.x = ((1000 % 256) + 0.5) * CELL_WIDTH;
  field.camera.y = (Math.floor(1000 / 256) + 0.5) * CELL_HEIGHT;
  field.camera.clamp();
  return { field, canvas, calls };
}
test('Camera.constructor centers a bounded world', () => {
  const c = new Camera(800, 600);
  assert.equal(c.x, 4608);
  assert.equal(c.y, 3360);
  assert.equal(c.zoom, 1);
});
test('Camera.clamp prevents world edges and invalid zoom exposing empty space', () => {
  const c = new Camera(800, 600);
  c.x = -1;
  c.y = 999999;
  c.zoom = 100;
  c.clamp();
  assert.equal(c.zoom, 3);
  assert.equal(c.x, 800 / 6);
  assert.equal(c.y, 6720 - 100);
  c.zoom = 0.01;
  c.clamp();
  assert.equal(c.zoom, 0.5);
});
test('Camera.resize updates the visible viewport while preserving bounds', () => {
  const c = new Camera(1, 1);
  c.resize(800, 600);
  assert.equal(c.width, 800);
  c.resize(0, 0);
  assert.equal(c.height, 1);
});
test('Camera.pan converts dragging into world displacement', () => {
  const c = new Camera(800, 600);
  c.zoom = 2;
  c.pan(100, -100);
  assert.equal(c.x, 4558);
  assert.equal(c.y, 3410);
});
test('Camera.worldToScreen projects the camera center and scaled offsets', () => {
  const c = new Camera(800, 600);
  assert.deepEqual(c.worldToScreen(c.x, c.y), { x: 400, y: 300 });
});
test('Camera.screenToWorld exactly inverts screen projection', () => {
  const c = new Camera(800, 600);
  c.zoom = 2;
  const p = c.worldToScreen(4400, 3300);
  assert.deepEqual(c.screenToWorld(p.x, p.y), { x: 4400, y: 3300 });
});
test('Camera.zoomAt keeps the pointed world coordinate stationary', () => {
  const c = new Camera(800, 600),
    before = c.screenToWorld(230, 150);
  c.zoomAt(2, 230, 150);
  assert.deepEqual(c.screenToWorld(230, 150), before);
});
test('Camera.visibleBounds culls the large world and bounds edge indices', () => {
  const c = new Camera(800, 600),
    b = c.visibleBounds();
  assert.ok((b.right - b.left) * (b.bottom - b.top) < 1000);
  c.x = 0;
  c.y = 0;
  assert.equal(c.visibleBounds().left, 0);
  c.x = 99999;
  c.y = 99999;
  assert.equal(c.visibleBounds().right, 256);
});
test('Camera.snapshot records an independent view object', () => {
  const c = new Camera(800, 600),
    s = c.snapshot();
  s.x = 1;
  assert.notEqual(c.x, s.x);
});
test('Camera.restore validates, restores, and clamps saved views', () => {
  const c = new Camera(800, 600);
  assert.equal(c.restore(null), false);
  assert.equal(c.restore({ x: NaN, y: 1, zoom: 1 }), false);
  assert.equal(c.restore({ x: 4000, y: 3000, zoom: 2 }), true);
  assert.equal(c.zoom, 2);
});
test('ClusterMotion.constructor starts with a stable cluster identity and anchor', () => {
  const m = new ClusterMotion(cluster, 10, 20, 100);
  assert.equal(m.cluster, cluster);
  assert.deepEqual(m.origin, { x: 10, y: 20 });
});
test('ClusterMotion.progress gathers in exactly 1500ms independently of frame count', () => {
  const m = new ClusterMotion(cluster, 0, 0, 100);
  assert.equal(m.progress(100), 0);
  assert.equal(m.progress(850), 0.5);
  assert.equal(m.progress(2000), 1);
  m.leave(850);
  assert.equal(m.progress(1075), 0.25);
});
test('ClusterMotion.anchorAt smoothly approaches the pointer without overshoot', () => {
  const m = new ClusterMotion(cluster, 0, 0, 0);
  m.move(100, 100, 0);
  const p = m.anchorAt(100);
  assert.ok(p.x > 60 && p.x < 65);
});
test('ClusterMotion.move preserves the current position when changing target', () => {
  const m = new ClusterMotion(cluster, 0, 0, 0);
  m.move(100, 0, 0);
  const p = m.anchorAt(100);
  m.move(200, 0, 100);
  assert.deepEqual(m.anchorAt(100), p);
});
test('ClusterMotion.leave smoothly releases only once', () => {
  const m = new ClusterMotion(cluster, 0, 0, 0);
  m.leave(750);
  m.leave(850);
  assert.equal(m.releasedAt, 750);
  assert.equal(m.progress(1200), 0);
});
test('ClusterMotion.ready requires completed gathering and no release', () => {
  const m = new ClusterMotion(cluster, 0, 0, 0);
  assert.equal(m.ready(1499), false);
  assert.equal(m.ready(1500), true);
  m.leave(1600);
  assert.equal(m.ready(1700), false);
});
test('ClusterMotion.position enlarges and attracts digits while reduced motion preserves location', () => {
  const m = new ClusterMotion(cluster, 50, 50, 0),
    base = { x: 300, y: 300 };
  assert.deepEqual(m.position(0, base, 0), { ...base, scale: 1 });
  const p = m.position(0, base, 1500);
  assert.equal(p.scale, 1.85);
  assert.ok(p.x < 100);
  assert.deepEqual(m.position(0, base, 1500, true), { ...base, scale: 1.85 });
});
test('NumberField.constructor supports a shared canvas and motion preference', () => {
  const canvas = { getContext: () => ({}) },
    f = new NumberField(canvas, { reducedMotion: true });
  assert.equal(f.effectCanvas, canvas);
  assert.equal(f.reducedMotion, true);
});
test('NumberField.resize scales backing resolution without changing camera units', () => {
  const { field, canvas } = fixture();
  assert.equal(canvas.width, 2000);
  field.resize(100, 200, 5);
  assert.equal(canvas.height, 400);
  assert.equal(field.camera.width, 100);
});
test('NumberField.setWorld indexes only active clusters and drops obsolete hover state', () => {
  const { field } = fixture();
  field.motion = new ClusterMotion(cluster, 0, 0, 0);
  field.setWorld({ ...field.world, clusters: [{ ...cluster, active: false }] });
  assert.equal(field.motion, null);
  assert.equal(field.clusterCells.size, 0);
});
test('NumberField.value uses stable seeded digits and explicit replacement overrides', () => {
  const { field } = fixture();
  assert.equal(field.value(1), field.value(1));
  assert.ok(field.value(2) >= 0 && field.value(2) < 10);
  field.replacements.set(1, 9);
  assert.equal(field.value(1), 9);
});
test('NumberField.basePosition moves normal and scary digits without changing logical identity', () => {
  const { field } = fixture();
  assert.notDeepEqual(field.basePosition(1000, 0), field.basePosition(1000, 1000));
  assert.notDeepEqual(field.basePosition(1002, 0), field.basePosition(1002, 1000));
  field.setReducedMotion(true);
  assert.deepEqual(field.basePosition(1000, 0), field.basePosition(1000, 1000));
});
test('NumberField.hitTest follows animated glyphs and excludes empty gaps and world boundaries', () => {
  const { field } = fixture();
  const p = field.basePosition(1000, 0);
  assert.equal(field.hitTest(p.x, p.y, 0).cluster.id, cluster.id);
  const normal = field.basePosition(1002, 0);
  assert.equal(field.hitTest(normal.x, normal.y, 0).cluster, null);
  assert.equal(field.hitTest(-99999, -99999, 0), null);
  field.motion = new ClusterMotion(cluster, p.x, p.y, 0);
  const attracted = field.motion.position(0, p, 1500);
  assert.equal(field.hitTest(attracted.x, attracted.y, 1500).cluster.id, cluster.id);
});
test('NumberField.hover acquires clusters and keeps attraction stable before release', () => {
  const { field } = fixture(),
    p = field.basePosition(1000, 0);
  assert.equal(field.hover(p.x, p.y, 0).id, cluster.id);
  assert.equal(field.hover(p.x + 20, p.y, 500).id, cluster.id);
  field.hover(-900, -900, 700);
  assert.notEqual(field.motion.releasedAt, null);
});
test('NumberField.leave marks attraction for release', () => {
  const { field } = fixture();
  field.leave(0);
  field.motion = new ClusterMotion(cluster, 0, 0, 0);
  field.leave(100);
  assert.equal(field.motion.releasedAt, 100);
});
test('NumberField.readyCluster exposes only a fully gathered target', () => {
  const { field } = fixture();
  assert.equal(field.readyCluster(0), null);
  field.motion = new ClusterMotion(cluster, 0, 0, 0);
  assert.equal(field.readyCluster(1500), cluster);
});
test('NumberField.replace immediately changes each captured digit', () => {
  const { field } = fixture(),
    old = field.value(1000);
  field.replace([1000], 2);
  assert.notEqual(field.value(1000), old);
});
test('NumberField.capture preserves occupied cells while starting a flight for every member', () => {
  const { field } = fixture();
  field.motion = new ClusterMotion(cluster, 400, 300, 0);
  field.capture(cluster, { x: 100, y: 700 }, 1500);
  assert.equal(field.particles.length, 5);
  assert.equal(field.replacements.size, 5);
  assert.equal(field.motion, null);
});
test('NumberField.setReducedMotion switches off positional motion', () => {
  const { field } = fixture();
  field.setReducedMotion(1);
  assert.equal(field.reducedMotion, true);
});
test('NumberField.draw renders a dense culled field, attraction, release, and finite flights', () => {
  const { field, calls } = fixture();
  field.draw(0);
  const count = field.visibleCount;
  assert.ok(count > 200 && count < 3000);
  assert.equal(calls.filter((c) => c[0] === 'digit').length, count);
  field.motion = new ClusterMotion(cluster, 400, 300, 0);
  field.draw(700);
  field.draw(1600);
  field.leave(1700);
  field.draw(2200);
  assert.equal(field.motion, null);
  field.capture(cluster, { x: 100, y: 650 }, 2300);
  field.draw(2400);
  assert.equal(field.visibleCount, count);
  field.draw(4000);
  assert.equal(field.particles.length, 0);
});
test('NumberField.dispose clears references and transient effects', () => {
  const { field } = fixture();
  field.capture(cluster, { x: 0, y: 0 }, 0);
  field.dispose();
  assert.equal(field.replacements.size, 0);
  assert.equal(field.particles.length, 0);
});
