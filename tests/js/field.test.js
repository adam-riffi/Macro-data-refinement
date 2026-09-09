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
test('Camera.clamp wraps world edges and constrains zoom', () => {
  const c = new Camera(800, 600);
  c.x = -1;
  c.y = 999999;
  c.zoom = 100;
  c.clamp();
  assert.equal(c.zoom, 3);
  assert.equal(c.x, 9215);
  assert.equal(c.y, 999999 % 6720);
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
  assert.ok(c.visibleBounds().left < 0);
  c.x = 99999;
  c.y = 99999;
  assert.ok(c.visibleBounds().right > 256);
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
test('ClusterMotion.position spreads subtle agitation outwards without attracting digits', () => {
  const m = new ClusterMotion(cluster, 50, 50, 0);
  const near = { x: 50, y: 50 },
    far = { x: 180, y: 50 };
  assert.equal(m.position(0, near, 400).scale > 1, true);
  assert.equal(m.position(1, far, 400).scale, 1);
  const p = m.position(1, far, 2000);
  assert.equal(p.scale, 1.06);
  assert.ok(Math.hypot(p.x - far.x, p.y - far.y) < 4);
  assert.deepEqual(m.position(1, far, 2000, true), { ...far, scale: 1.06 });
  m.move(900, 900, 2000);
  const later = m.position(1, far, 3000);
  assert.ok(Math.hypot(later.x - far.x, later.y - far.y) < 4);
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

test('Camera.clamp wraps smaller worlds without inverted bounds', () => {
  const camera = new Camera(1200, 900, 10, 8);
  camera.pan(100000, -100000);
  assert.deepEqual(camera.snapshot(), { x: 260, y: 40, zoom: 1 });
  assert.ok(camera.visibleBounds(0).left < 0);
});

test('Camera.zoomAt clamps both limits while keeping an interior pointer anchor stable', () => {
  const camera = new Camera(1200, 800);
  const point = camera.screenToWorld(375, 210);
  camera.zoomAt(100, 375, 210);
  assert.equal(camera.zoom, 3);
  assert.deepEqual(camera.screenToWorld(375, 210), point);
  camera.zoomAt(0.001, 375, 210);
  assert.equal(camera.zoom, 0.5);
  assert.deepEqual(camera.screenToWorld(375, 210), point);
});

test('Camera.visibleBounds covers the viewport across wrapped corners at every zoom', () => {
  const camera = new Camera(1440, 900);
  for (const zoom of [0.5, 1, 3]) {
    for (const x of [-100000, 100000]) {
      for (const y of [-100000, 100000]) {
        camera.restore({ x, y, zoom });
        const bounds = camera.visibleBounds(0);
        assert.ok(camera.x >= 0 && camera.y >= 0);
        assert.ok(camera.x < 256 * CELL_WIDTH && camera.y < 160 * CELL_HEIGHT);
        assert.ok(bounds.left < bounds.right && bounds.top < bounds.bottom);
        const start = camera.screenToWorld(0, 0);
        const end = camera.screenToWorld(camera.width, camera.height);
        assert.ok(bounds.left * CELL_WIDTH <= start.x && bounds.top * CELL_HEIGHT <= start.y);
        assert.ok(bounds.right * CELL_WIDTH >= end.x && bounds.bottom * CELL_HEIGHT >= end.y);
      }
    }
  }
});

test('Camera.restore rejects incomplete, infinite, and nonnumeric values without altering the view', () => {
  const camera = new Camera(800, 600);
  const before = camera.snapshot();
  for (const value of [
    undefined,
    {},
    { x: 3, y: 4 },
    { x: 3, y: Infinity, zoom: 1 },
    { x: '3', y: 4, zoom: 1 },
  ]) {
    assert.equal(camera.restore(value), false);
    assert.deepEqual(camera.snapshot(), before);
  }
  assert.equal(camera.restore({ x: -100000, y: 100000, zoom: 10 }), true);
  assert.equal(camera.zoom, 3);
  assert.ok(camera.x > 0 && camera.y < 160 * CELL_HEIGHT);
});

test('ClusterMotion.progress clamps pre-start and late frames and returns fully to rest after release', () => {
  const motion = new ClusterMotion(cluster, 0, 0, 1000);
  assert.equal(motion.progress(0), 0);
  assert.equal(motion.progress(100000), 1);
  motion.leave(2500);
  assert.equal(motion.progress(2725), 0.5);
  assert.equal(motion.progress(2950), 0);
  assert.equal(motion.progress(100000), 0);
});

test('ClusterMotion.anchorAt cannot travel backwards before its latest target change', () => {
  const motion = new ClusterMotion(cluster, 10, 20, 1000);
  motion.move(210, 320, 1100);
  assert.deepEqual(motion.anchorAt(1000), { x: 10, y: 20 });
  const settled = motion.anchorAt(100000);
  assert.deepEqual(settled, { x: 210, y: 320 });
  assert.deepEqual(motion.origin, { x: 10, y: 20 });
});

test('ClusterMotion.position gives differently indexed members distinct gathered positions and returns to base', () => {
  const motion = new ClusterMotion(cluster, 100, 100, 0);
  const base = { x: 300, y: 400 };
  const gathered = cluster.cells.map((_, index) => motion.position(index, base, 1500));
  assert.equal(
    new Set(gathered.map((point) => `${point.x}:${point.y}`)).size,
    cluster.cells.length,
  );
  assert.ok(gathered.every((point) => Math.hypot(point.x - base.x, point.y - base.y) < 4));
  motion.leave(1500);
  assert.deepEqual(motion.position(3, base, 1950), { ...base, scale: 1 });
});

test('NumberField.constructor and resize use quiet defaults and a single canvas backing store', () => {
  const context = {};
  const calls = [];
  const canvas = {
    getContext: (...arguments_) => {
      calls.push(arguments_);
      return context;
    },
  };
  const field = new NumberField(canvas);
  assert.equal(field.effectContext, context);
  assert.equal(field.reducedMotion, false);
  assert.deepEqual(calls, [['2d', { alpha: false }]]);
  field.resize(401, 303);
  assert.equal(field.dpr, 1);
  assert.equal(canvas.width, 401);
  field.resize(401, 303, 0.25);
  assert.equal(field.dpr, 1);
  assert.equal(canvas.height, 303);
});

test('NumberField.setWorld preserves a still-active gathering and cancels removed identities', () => {
  const { field } = fixture();
  const motion = new ClusterMotion(cluster, 400, 300, 0);
  field.motion = motion;
  field.setWorld({
    ...field.world,
    clusters: [{ ...cluster }, { ...cluster, id: '1:0', cells: [1515], active: false }],
  });
  assert.equal(field.motion, motion);
  assert.equal(field.clusterCells.size, cluster.cells.length);
  assert.equal(field.clusterCells.has(1515), false);
  field.setWorld({ ...field.world, clusters: [{ ...cluster, id: '0:1' }] });
  assert.equal(field.motion, null);
});

test('NumberField.value is reproducible across instances but varies with world seed and cell identity', () => {
  const { field } = fixture();
  const twin = fixture().field;
  const values = Array.from({ length: 512 }, (_, id) => field.value(id));
  assert.deepEqual(
    values,
    Array.from({ length: 512 }, (_, id) => twin.value(id)),
  );
  assert.equal(new Set(values).size, 10);
  twin.setWorld({ ...twin.world, seed: 18 });
  assert.notDeepEqual(
    values,
    Array.from({ length: 512 }, (_, id) => twin.value(id)),
  );
  assert.ok(values.every((value) => Number.isInteger(value) && value >= 0 && value <= 9));
});

test('NumberField.basePosition bounds positional drift and reduced motion keeps every cell centered', () => {
  const { field } = fixture();
  for (const id of [1000, 1002]) {
    const center = field.camera.worldToScreen(
      ((id % 256) + 0.5) * CELL_WIDTH,
      (Math.floor(id / 256) + 0.5) * CELL_HEIGHT,
    );
    for (const now of [0, 500, 1000, 5000, 100000]) {
      const position = field.basePosition(id, now);
      const maximum = field.clusterCells.has(id) ? 4 : 2.4;
      assert.ok(Math.abs(position.x - center.x) <= maximum + 0.000001);
      assert.ok(Math.abs(position.y - center.y) <= maximum + 0.000001);
    }
    field.setReducedMotion(true);
    assert.deepEqual(field.basePosition(id, 5432), center);
    field.setReducedMotion(false);
  }
});

test('NumberField.hitTest can traverse every gathered member and ignore the gap between ordinary cells', () => {
  const { field } = fixture();
  field.setReducedMotion(true);
  const base = field.basePosition(1000, 0);
  field.motion = new ClusterMotion(cluster, base.x, base.y, 0);
  const last = field.basePosition(1514, 1500);
  assert.equal(field.hitTest(last.x, last.y, 1500).id, 1514);
  field.motion = null;
  const ordinary = field.basePosition(1002, 0);
  assert.equal(field.hitTest(ordinary.x + CELL_WIDTH / 2, ordinary.y + CELL_HEIGHT / 2, 0), null);
  const edge = field.camera.worldToScreen(256 * CELL_WIDTH + 1000, 160 * CELL_HEIGHT + 1000);
  assert.ok(field.hitTest(edge.x, edge.y, 0));
});

test('NumberField.hover retains agitation while the pointer stays near cluster members', () => {
  const { field } = fixture();
  const pointer = field.basePosition(1000, 0);
  field.hover(pointer.x, pointer.y, 0);
  const motion = field.motion;
  for (const now of [150, 450, 750, 1000, 1500, 1800]) {
    assert.equal(field.hover(pointer.x + 12, pointer.y, now), cluster);
    assert.equal(field.motion, motion);
    assert.equal(motion.startedAt, 0);
  }
  assert.equal(field.readyCluster(1800), cluster);
  assert.ok(motion.anchorAt(1900).x > pointer.x);
});

test('NumberField.hover handles ordinary cells, released targets, and a distinct newly discovered cluster', () => {
  const { field } = fixture();
  field.setReducedMotion(true);
  const ordinary = field.basePosition(1002, 0);
  assert.equal(field.hover(ordinary.x, ordinary.y, 0), null);
  const first = field.basePosition(1000, 0);
  field.hover(first.x, first.y, 0);
  field.leave(400);
  assert.equal(field.hover(first.x, first.y, 450), cluster);
  assert.equal(field.motion.releasedAt, null);
  assert.equal(field.motion.startedAt, 450);
  const other = { ...cluster, id: '1:0', cells: [1020], slot: 1 };
  field.setWorld({ ...field.world, clusters: [cluster, other] });
  const next = field.basePosition(1020, 500);
  assert.equal(field.hover(next.x, next.y, 500), other);
  assert.equal(field.motion.startedAt, 500);
  assert.equal(field.motion.releasedAt, null);
});

test('NumberField.readyCluster ignores partial gathering and all released clusters', () => {
  const { field } = fixture();
  field.motion = new ClusterMotion(cluster, 400, 300, 100);
  assert.equal(field.readyCluster(1599), null);
  assert.equal(field.readyCluster(1600), cluster);
  field.leave(1600);
  assert.equal(field.readyCluster(1601), null);
});

test('NumberField.replace always changes a digit for every respawn generation without clearing other cells', () => {
  const { field } = fixture();
  const unaffected = field.value(1002);
  field.replace([1000]);
  for (let generation = 0; generation < 40; generation++) {
    const old = cluster.cells.map((id) => field.value(id));
    field.replace(cluster.cells, generation);
    cluster.cells.forEach((id, index) => {
      assert.notEqual(field.value(id), old[index]);
      assert.ok(field.value(id) >= 0 && field.value(id) <= 9);
    });
  }
  assert.equal(field.value(1002), unaffected);
  assert.equal(field.replacements.size, cluster.cells.length);
});

test('NumberField.capture snapshots original glyphs and targets while refill remains immediately complete', () => {
  const { field } = fixture();
  const originals = cluster.cells.map((id) => field.value(id));
  const target = { x: 100, y: 650 };
  field.motion = new ClusterMotion(cluster, 400, 300, 0);
  const origin = field.motion.position(0, field.basePosition(1000, 1500), 1500);
  field.capture(cluster, target, 1500);
  target.x = 999;
  assert.deepEqual(
    field.particles.map((particle) => particle.value),
    originals,
  );
  assert.deepEqual(field.particles[0].from, origin);
  assert.ok(
    field.particles.every((particle) => particle.target.x === 100 && particle.duration === 680),
  );
  assert.deepEqual(
    field.particles.map((particle) => particle.startedAt),
    [1500, 1512, 1524, 1536, 1548],
  );
  cluster.cells.forEach((id, index) => assert.notEqual(field.value(id), originals[index]));
});

test('NumberField.capture uses base positions for unmatched targets and shortened reduced-motion flights', () => {
  const { field } = fixture();
  field.setReducedMotion(true);
  field.motion = new ClusterMotion({ ...cluster, id: 'different' }, 400, 300, 0);
  const base = field.basePosition(1000, 1500);
  field.capture(cluster, { x: 100, y: 650 }, 1500);
  assert.deepEqual(field.particles[0].from, base);
  assert.ok(field.particles.every((particle) => particle.duration === 100));
  field.draw(1649);
  assert.equal(field.particles.length, 0);
});

test('NumberField.draw preserves all visible replacement cells during a flight and clears only the effects canvas', () => {
  const { field, calls } = fixture();
  const cleared = [];
  const effects = [];
  field.effectContext = {
    setTransform() {},
    clearRect(...arguments_) {
      cleared.push(arguments_);
    },
    fillText(...arguments_) {
      effects.push(arguments_);
    },
  };
  field.draw(0);
  const count = field.visibleCount;
  field.capture(cluster, { x: 150, y: 650 }, 10);
  calls.length = 0;
  field.draw(11);
  assert.equal(field.visibleCount, count);
  assert.equal(calls.filter((call) => call[0] === 'digit').length, count);
  assert.equal(effects.length, cluster.cells.length);
  assert.deepEqual(cleared, [
    [0, 0, 1000, 700],
    [0, 0, 1000, 700],
  ]);
  assert.equal(field.effectContext.globalAlpha, 1);
  const first = effects[0];
  effects.length = 0;
  field.draw(400);
  assert.notDeepEqual(effects[0], first);
  field.draw(1000);
  assert.equal(field.particles.length, 0);
  assert.equal(field.visibleCount, count);
});

test('NumberField.draw supports a shared canvas without clearing the densely rendered field', () => {
  const { field, canvas, calls } = fixture();
  const shared = new NumberField(canvas);
  shared.resize(600, 400);
  shared.draw(0);
  assert.ok(shared.visibleCount > 100);
  assert.equal(calls.filter((call) => call[0] === 'background').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'digit').length, shared.visibleCount);
  assert.equal(shared.context.globalAlpha, 1);
});

test('NumberField.draw animates a partial release before removing its expired overlay', () => {
  const { field, calls } = fixture();
  field.motion = new ClusterMotion(cluster, 400, 300, 0);
  field.leave(1500);
  field.draw(1600);
  assert.notEqual(field.motion, null);
  assert.equal(calls.filter((call) => call[0] === 'digit').length, field.visibleCount);
  field.draw(1950);
  assert.equal(field.motion, null);
});

test('NumberField.dispose is repeatable and clears cluster hit targets as well as active attraction', () => {
  const { field } = fixture();
  field.motion = new ClusterMotion(cluster, 400, 300, 0);
  field.replace(cluster.cells);
  field.dispose();
  field.dispose();
  assert.equal(field.motion, null);
  assert.equal(field.clusterCells.size, 0);
  assert.equal(field.replacements.size, 0);
  assert.deepEqual(field.particles, []);
});

test('NumberField.hover scales the attraction boundary with zoom so enlarged groups stay acquired', () => {
  const { field } = fixture();
  field.camera.zoom = 3;
  field.motion = new ClusterMotion(cluster, 500, 350, 0);
  assert.equal(field.hover(700, 350, 1600), cluster);
  assert.equal(field.readyCluster(1600), cluster);
  field.hover(1000, 350, 1700);
  assert.equal(field.readyCluster(1700), null);
});

test('NumberField.hover restarts gathering when returning during release without another pointer move', () => {
  const { field } = fixture();
  field.setReducedMotion(true);
  const p = field.basePosition(1000, 0);
  field.hover(p.x, p.y, 0);
  field.leave(100);
  field.hover(p.x, p.y, 200);
  field.draw(700);
  assert.equal(field.readyCluster(1699), null);
  field.draw(1700);
  assert.equal(field.readyCluster(1700), cluster);
});

test('NumberField.draw leaves captured cells empty before gradually fading replacements in', () => {
  const { field } = fixture();
  const samples = [];
  field.context.fillText = function (value, x, y) {
    samples.push({ x, y, alpha: this.globalAlpha });
  };
  field.capture(cluster, { x: 0, y: 0 }, 0);
  field.particles = [];
  for (const [now, alpha] of [
    [500, 0],
    [1550, 0.5],
    [2500, 1],
  ]) {
    samples.length = 0;
    field.draw(now);
    const base = field.basePosition(cluster.cells[0], now);
    assert.equal(samples.find((p) => p.x === base.x && p.y === base.y).alpha, alpha);
  }
  assert.equal(field.refills.size, 0);
});
test('NumberField wraps navigation and hit testing seamlessly across all four edges', () => {
  const { field } = fixture();
  field.setReducedMotion(true);
  for (const [x, y] of [
    [0, 0],
    [9215, 6719],
    [0, 6719],
    [9215, 0],
  ]) {
    field.camera.restore({ x, y, zoom: 1 });
    for (const id of [0, 255, 159 * 256, 40959]) {
      const p = field.basePosition(id, 0);
      assert.equal(field.hitTest(p.x, p.y, 0).id, id);
    }
    field.draw(0);
    assert.ok(field.visibleCount > 400);
  }
  field.camera.restore({ x: 10, y: 10, zoom: 1 });
  field.camera.pan(20, 20);
  assert.deepEqual(field.camera.snapshot(), { x: 9206, y: 6710, zoom: 1 });
  field.camera.pan(-20, -20);
  assert.deepEqual(field.camera.snapshot(), { x: 10, y: 10, zoom: 1 });
});
