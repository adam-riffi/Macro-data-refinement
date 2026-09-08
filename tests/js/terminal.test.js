import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { RefinementTerminal } from '../../public/assets/terminal.js';
import { ClusterMotion, NumberField } from '../../public/assets/field.js';
import { LocalSessionStore, RefinementApi, TerminalAudio } from '../../public/assets/session.js';

const source = readFileSync(new URL('../../templates/terminal.html', import.meta.url), 'utf8');
const html = source.replace(/{% for number in range\(1, 6\) %}([\s\S]*?){% endfor %}/, (_, body) =>
  Array.from({ length: 5 }, (_, index) => body.replaceAll('{{ number }}', String(index + 1))).join(
    '',
  ),
);

function envelope(overrides = {}, feedback) {
  return {
    token: 'signed-token',
    state: {
      id: 'file-one',
      file: 'Cold Harbor',
      mode: 'quota',
      difficulty: 'normal',
      status: 'active',
      score: 0,
      mistakes: 0,
      max_mistakes: null,
      progress: 0,
      cycle: 1,
      refined_digits: 0,
      captured_clusters: 0,
      elapsed_seconds: 0,
      remaining_seconds: null,
      revision: 0,
      bins: Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        count: 0,
        capacity: 100,
        progress: 0,
      })),
      world: {
        seed: 42,
        columns: 256,
        rows: 160,
        clusters: [
          {
            id: '0:0',
            slot: 0,
            generation: 0,
            cells: [20608, 20609, 20865],
            bin: 1,
            points: 34,
            active: true,
          },
          {
            id: '1:0',
            slot: 1,
            generation: 0,
            cells: [20613, 20614, 20870, 21126],
            bin: 2,
            points: 42,
            active: true,
          },
          {
            id: '2:0',
            slot: 2,
            generation: 0,
            cells: [0, 1, 257],
            bin: 3,
            points: 32,
            active: true,
          },
          {
            id: '3:0',
            slot: 3,
            generation: 0,
            cells: [20500, 20501, 20757],
            bin: 4,
            points: 35,
            active: false,
          },
        ],
      },
      ...overrides,
    },
    ...(feedback ? { feedback } : {}),
  };
}

function setup(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://refinement.example/', pretendToBeVisual: true });
  const { window } = dom,
    { document } = window;
  const clock = { value: 1000 };
  Object.defineProperty(window.performance, 'now', { value: () => clock.value });
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
  const canvasCalls = [];
  const context = {
    setTransform() {},
    fillRect() {},
    fillText() {},
    beginPath() {},
    arc() {},
    stroke() {},
    clearRect() {},
    moveTo() {},
    lineTo() {},
    strokeRect: (...args) => canvasCalls.push(args),
  };
  window.HTMLCanvasElement.prototype.getContext = () => context;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  const animations = new Map();
  let animationId = 0;
  window.requestAnimationFrame = (callback) => {
    animations.set(++animationId, callback);
    return animationId;
  };
  window.cancelAnimationFrame = (id) => animations.delete(id);
  window.matchMedia = () => ({ matches: !!options.systemMotion });
  const calls = [];
  const api = {
    create: async (...args) => {
      calls.push(['create', ...args]);
      return envelope();
    },
    restore: async (...args) => {
      calls.push(['restore', ...args]);
      return envelope();
    },
    capture: async (...args) => {
      calls.push(['capture', ...args]);
      const result = envelope(
        { score: 34, revision: 1, captured_clusters: 1, refined_digits: 3 },
        { accepted: true, message: '3 numbers refined.', points: 34, bin: 1 },
      );
      result.state.world.clusters[0].id = '0:1';
      result.state.world.clusters[0].generation = 1;
      result.state.world.clusters[0].cells = [21000, 21001, 21257];
      return result;
    },
    mistake: async (...args) => {
      calls.push(['mistake', ...args]);
      return envelope({}, { accepted: false, message: 'Ordinary numbers.', points: 0 });
    },
    ...options.api,
  };
  const audio = {
    enabled: false,
    played: [],
    disposed: false,
    setEnabled(value) {
      this.enabled = value;
    },
    play(kind) {
      this.played.push(kind);
    },
    dispose() {
      this.disposed = true;
    },
  };
  const store = new LocalSessionStore(window.localStorage);
  if (options.savedToken) store.saveToken(options.savedToken);
  if (options.preferences) store.savePreferences(options.preferences);
  const terminal = new RefinementTerminal(document, window, { api, store, audio });
  terminal.element('help-button').getBoundingClientRect = () => ({ bottom: 110 });
  terminal.element('feedback').getBoundingClientRect = () => ({ top: 550 });
  terminal.element('bin-1').getBoundingClientRect = () => ({
    left: 50,
    top: 560,
    width: 160,
    height: 80,
  });
  terminal.resize();
  t.after(() => {
    terminal.destroy();
    dom.window.close();
  });
  return {
    terminal,
    field: terminal.field,
    document,
    window,
    clock,
    calls,
    api,
    store,
    audio,
    animations,
    canvasCalls,
  };
}

function pointer(overrides = {}) {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: 500,
    clientY: 350,
    ...overrides,
  };
}

function keyEvent(terminal, key, target = terminal.canvas) {
  return {
    key,
    target,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

async function settle() {
  await new Promise(setImmediate);
}

test('RefinementTerminal.constructor initializes dependencies state and real canvas renderer', (t) => {
  const { terminal, document, window, api, store, audio } = setup(t);
  assert.equal(terminal.document, document);
  assert.equal(terminal.window, window);
  assert.equal(terminal.api, api);
  assert.equal(terminal.store, store);
  assert.equal(terminal.audio, audio);
  assert.ok(terminal.field instanceof NumberField);
  assert.equal(terminal.state, null);
  assert.equal(terminal.busy, false);
  assert.equal(terminal.destroyed, false);
  assert.equal(terminal.pointers.size, 0);
  assert.equal(terminal.gatheringFeedback, false);
  const defaults = new RefinementTerminal(document, window);
  assert.ok(defaults.api instanceof RefinementApi);
  assert.ok(defaults.audio instanceof TerminalAudio);
  defaults.destroy();
  Object.defineProperty(window, 'localStorage', {
    get() {
      throw new Error('blocked');
    },
  });
  const denied = new RefinementTerminal(document, window, { field: terminal.field });
  assert.equal(denied.store.storage, null);
  assert.equal(denied.field, terminal.field);
  denied.destroy();
});

test('RefinementTerminal.element resolves a terminal node and returns null for absent ids', (t) => {
  const { terminal, document } = setup(t);
  assert.equal(terminal.element('number-field'), document.getElementById('number-field'));
  assert.equal(terminal.element('missing'), null);
});

test('RefinementTerminal.listen registers and records exact event cleanup arguments', (t) => {
  const { terminal, window } = setup(t);
  let calls = 0;
  const handler = () => {
      calls += 1;
    },
    options = { passive: true };
  terminal.listen(terminal.canvas, 'custom', handler, options);
  terminal.canvas.dispatchEvent(new window.Event('custom'));
  assert.equal(calls, 1);
  assert.deepEqual(terminal.listeners[0], [terminal.canvas, 'custom', handler, options]);
});

test('RefinementTerminal.init restores preferences starts animation and connects a new file', async (t) => {
  const { terminal, calls, audio, store, animations } = setup(t, {
    systemMotion: true,
    preferences: { sound: true, reducedMotion: false },
  });
  await terminal.init();
  assert.deepEqual(calls[0], ['create']);
  assert.equal(terminal.state.id, 'file-one');
  assert.equal(audio.enabled, true);
  assert.equal(terminal.field.reducedMotion, true);
  assert.deepEqual(store.preferences(), { sound: true, reducedMotion: true });
  assert.equal(terminal.listeners.length, 24);
  const callback = animations.get(terminal.animation);
  callback(1100);
  animations.get(terminal.animation)(1200);
  assert.equal(terminal.lastFrame, 1200);
});

test('RefinementTerminal.init wires lifecycle pointer keyboard controls forms and retry callbacks', async (t) => {
  const { terminal, window, document, calls } = setup(t, { savedToken: 'saved' });
  await terminal.init();
  assert.deepEqual(calls[0], ['restore', 'saved']);
  const methods = [
    'resize',
    'saveView',
    'pointerDown',
    'pointerMove',
    'pointerUp',
    'pointerCancel',
    'wheel',
    'keydown',
    'startAssignment',
    'configure',
    'zoom',
    'focusSignal',
  ];
  const spies = Object.fromEntries(
    methods.map((method) => [method, t.mock.method(terminal, method, () => {})]),
  );
  window.dispatchEvent(new window.Event('resize'));
  window.dispatchEvent(new window.Event('pagehide'));
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(spies.saveView.mock.callCount(), 2);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
  await settle();
  terminal.busy = true;
  document.dispatchEvent(new window.Event('visibilitychange'));
  terminal.busy = false;
  terminal.token = null;
  document.dispatchEvent(new window.Event('visibilitychange'));
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'])
    terminal.canvas.dispatchEvent(new window.Event(name));
  for (const name of ['pointerDown', 'pointerMove', 'pointerUp', 'pointerCancel', 'wheel'])
    assert.equal(spies[name].mock.callCount(), 1);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x' }));
  assert.equal(spies.keydown.mock.callCount(), 1);
  const leave = t.mock.method(terminal.field, 'leave', () => {});
  terminal.canvas.dispatchEvent(new window.Event('pointerleave'));
  terminal.pointers.set(1, {});
  terminal.canvas.dispatchEvent(new window.Event('pointerleave'));
  terminal.pointers.clear();
  assert.equal(leave.mock.callCount(), 1);
  for (const panel of ['assignment', 'settings', 'help', 'history']) {
    terminal.element(`${panel}-button`).click();
    assert.equal(terminal.element(`${panel}-panel`).hidden, false);
  }
  terminal.element('next-assignment').click();
  assert.equal(terminal.element('assignment-panel').hidden, false);
  terminal.element('close-dialog').click();
  assert.equal(terminal.element('terminal-dialog').open, false);
  terminal
    .element('assignment-form')
    .dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal(spies.startAssignment.mock.callCount(), 1);
  for (const setting of ['sound', 'motion'])
    terminal.element(`${setting}-setting`).dispatchEvent(new window.Event('change'));
  assert.equal(spies.configure.mock.callCount(), 2);
  terminal.element('zoom-in').click();
  terminal.element('zoom-out').click();
  assert.deepEqual(
    spies.zoom.mock.calls.map((call) => call.arguments[0]),
    [1.25, 0.8],
  );
  terminal.element('signals-button').click();
  assert.equal(spies.focusSignal.mock.callCount(), 1);
  terminal.retry = null;
  terminal.element('retry-button').click();
  let retried = false;
  terminal.retry = () => {
    retried = true;
  };
  terminal.element('retry-button').click();
  assert.equal(retried, true);
});

test('RefinementTerminal.init supports browsers without matchMedia', async (t) => {
  const { terminal, window } = setup(t);
  window.matchMedia = undefined;
  await terminal.init();
  assert.equal(terminal.field.reducedMotion, false);
});

test('RefinementTerminal.resize uses viewport dimensions and falls back to unit pixel ratio', (t) => {
  const { terminal, window, field } = setup(t);
  Object.defineProperty(window, 'devicePixelRatio', { value: 0, configurable: true });
  terminal.resize();
  assert.equal(field.camera.width, 1000);
  assert.equal(field.camera.height, 700);
  assert.equal(field.dpr, 1);
});

test('RefinementTerminal.frame throttles drawing updates gathering feedback and periodically saves view', (t) => {
  const { terminal, field, animations, document, store } = setup(t);
  terminal.applyState(envelope());
  const cluster = terminal.state.world.clusters[0];
  field.motion = new ClusterMotion(cluster, 500, 350, 1000);
  terminal.frame(1750);
  assert.match(terminal.element('feedback').textContent, /GATHERING 50%/);
  assert.equal(terminal.lastSave, 1750);
  assert.ok(store.view('file-one'));
  terminal.frame(2500);
  assert.match(terminal.element('feedback').textContent, /3 NUMBERS · CLICK TO REFINE/);
  terminal.frame(2501);
  assert.equal(terminal.lastFrame, 2500);
  terminal.busy = true;
  terminal.frame(2550);
  terminal.busy = false;
  field.leave(2600);
  terminal.frame(2650);
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  terminal.frame(4000);
  assert.equal(terminal.lastFrame, 2650);
  const animationCount = animations.size;
  terminal.destroyed = true;
  terminal.frame(5000);
  assert.equal(animations.size, animationCount);
});

test('RefinementTerminal.frame clears gathering instructions when a signal is released', (t) => {
  const { terminal, field } = setup(t);
  terminal.applyState(envelope());
  field.motion = new ClusterMotion(terminal.state.world.clusters[0], 500, 350, 1000);
  terminal.frame(2500);
  assert.match(terminal.element('feedback').textContent, /CLICK TO REFINE/);
  assert.equal(terminal.gatheringFeedback, true);
  field.leave(2600);
  terminal.frame(2700);
  assert.equal(terminal.element('feedback').textContent, 'SIGNAL RELEASED. CONTINUE REFINEMENT.');
  assert.equal(terminal.element('announcer').textContent, 'Signal released. Continue refinement.');
  assert.equal(terminal.gatheringFeedback, false);
  terminal.frame(3200);
  assert.equal(field.motion, null);
  assert.equal(terminal.element('feedback').textContent, 'SIGNAL RELEASED. CONTINUE REFINEMENT.');
});

test('RefinementTerminal.frame defers release feedback while an authoritative request is pending', (t) => {
  const { terminal, field } = setup(t);
  terminal.applyState(envelope());
  field.motion = new ClusterMotion(terminal.state.world.clusters[0], 500, 350, 1000);
  terminal.frame(1750);
  const gathering = terminal.element('feedback').textContent;
  terminal.busy = true;
  field.leave(1800);
  terminal.frame(1900);
  terminal.frame(2400);
  assert.equal(field.motion, null);
  assert.equal(terminal.element('feedback').textContent, gathering);
  assert.equal(terminal.gatheringFeedback, true);
  terminal.busy = false;
  terminal.frame(2500);
  assert.equal(terminal.element('feedback').textContent, 'SIGNAL RELEASED. CONTINUE REFINEMENT.');
  assert.equal(terminal.gatheringFeedback, false);
});

test('RefinementTerminal.frame preserves server feedback and network errors after a gathered signal releases', async (t) => {
  const { terminal, field } = setup(t);
  terminal.applyState(envelope());
  for (const [index, feedback] of [
    { accepted: true, message: '3 numbers refined.', points: 34 },
    { accepted: false, message: 'These numbers do not require refinement.', points: -50 },
  ].entries()) {
    const started = 1000 + index * 3000;
    field.motion = new ClusterMotion(terminal.state.world.clusters[0], 500, 350, started);
    terminal.frame(started + 1500);
    assert.equal(terminal.gatheringFeedback, true);
    field.leave(started + 1600);
    terminal.applyState(envelope({}, feedback));
    const authoritative = terminal.element('feedback').textContent;
    assert.match(authoritative, /PTS$/);
    assert.equal(terminal.gatheringFeedback, false);
    terminal.frame(started + 2200);
    assert.equal(field.motion, null);
    assert.equal(terminal.element('feedback').textContent, authoritative);
  }
  field.motion = new ClusterMotion(terminal.state.world.clusters[0], 500, 350, 7000);
  terminal.frame(8500);
  field.leave(8600);
  await terminal.transact(async () => {
    throw new Error('Connection interrupted. Retry your saved file.');
  });
  terminal.frame(9200);
  assert.equal(terminal.gatheringFeedback, false);
  assert.equal(
    terminal.element('feedback').textContent,
    'CONNECTION INTERRUPTED. RETRY YOUR SAVED FILE.',
  );
});

test('RefinementTerminal.transact serializes requests and applies only successfully returned state', async (t) => {
  const { terminal, store } = setup(t);
  let resolve;
  const pending = terminal.transact(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  assert.equal(terminal.busy, true);
  assert.equal(terminal.element('start-button').disabled, true);
  assert.equal(
    await terminal.transact(() => {
      throw new Error('must not run');
    }),
    false,
  );
  resolve(envelope());
  assert.equal(await pending, true);
  assert.equal(store.token(), 'signed-token');
  assert.equal(terminal.busy, false);
  assert.equal(terminal.element('start-button').disabled, false);
  terminal.destroyed = true;
  assert.equal(await terminal.transact(() => Promise.resolve(envelope())), false);
});

test('RefinementTerminal.transact ignores a response arriving after teardown', async (t) => {
  const { terminal, store } = setup(t);
  let resolve;
  const pending = terminal.transact(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  terminal.destroy();
  resolve(envelope());
  assert.equal(await pending, false);
  assert.equal(store.token(), null);
});

test('RefinementTerminal.transact animates accepted captures into the server assigned bin only', async (t) => {
  const { terminal, field, api } = setup(t);
  terminal.applyState(envelope());
  const cluster = terminal.state.world.clusters[0];
  assert.equal(
    await terminal.transact(() => api.capture('signed-token', cluster.id), cluster),
    true,
  );
  assert.equal(field.particles.length, 3);
  assert.deepEqual(field.particles[0].target, { x: 130, y: 600 });
  const size = field.replacements.size;
  await terminal.transact(
    () =>
      Promise.resolve(envelope({}, { accepted: false, message: 'Already captured.', points: 0 })),
    cluster,
  );
  assert.equal(field.replacements.size, size);
});

test('RefinementTerminal.transact retains saves on network errors and retries the same operation', async (t) => {
  const { terminal, store } = setup(t);
  terminal.applyState(envelope());
  let attempts = 0;
  const operation = async () => {
    if (++attempts === 1) throw new Error('Network offline.');
    return envelope({ score: 20 });
  };
  assert.equal(await terminal.transact(operation), false);
  assert.equal(terminal.state.score, 0);
  assert.equal(store.token(), 'signed-token');
  assert.equal(terminal.element('retry-button').hidden, false);
  assert.match(terminal.element('retry-button').textContent, /CONNECTION INTERRUPTED/);
  assert.equal(await terminal.retry(), true);
  assert.equal(terminal.state.score, 20);
  assert.equal(terminal.retry, null);
  assert.equal(terminal.element('retry-button').hidden, true);
});

test('RefinementTerminal.transact displays assignment failures inside the modal and clears stale errors before retrying', async (t) => {
  const { terminal, store } = setup(t);
  terminal.applyState(envelope());
  terminal.openDialog('assignment');
  const alert = terminal.element('dialog-feedback');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.ok(terminal.element('terminal-dialog').contains(alert));
  const message = 'Connection failed. <img src=x onerror=alert(1)>';
  assert.equal(
    await terminal.transact(async () => {
      throw new Error(message);
    }),
    false,
  );
  assert.equal(alert.textContent, message);
  assert.equal(alert.querySelector('img'), null);
  assert.equal(terminal.element('terminal-dialog').open, true);
  assert.equal(store.token(), 'signed-token');

  let resolve;
  const pending = terminal.transact(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  assert.equal(alert.textContent, '');
  resolve(envelope());
  assert.equal(await pending, true);
  assert.equal(alert.textContent, '');
});

test('RefinementTerminal.transact offers new assignment after unavailable saves without deleting them', async (t) => {
  const { terminal, store } = setup(t);
  terminal.applyState(envelope());
  for (const status of [400, 410]) {
    const error = Object.assign(new Error('Save unavailable.'), { status });
    assert.equal(
      await terminal.transact(async () => {
        throw error;
      }),
      false,
    );
    assert.match(terminal.element('retry-button').textContent, /OPEN A NEW FILE/);
    terminal.retry();
    assert.equal(terminal.element('assignment-panel').hidden, false);
    assert.equal(store.token(), 'signed-token');
    terminal.closeDialog();
  }
});

test('RefinementTerminal.connect creates without a token and restores a signed current token', async (t) => {
  const { terminal, calls } = setup(t);
  assert.equal(await terminal.connect(), true);
  assert.equal(await terminal.connect(), true);
  assert.deepEqual(calls, [['create'], ['restore', 'signed-token']]);
});

test('RefinementTerminal.startAssignment sends selected settings and closes only after success', async (t) => {
  const { terminal, calls, api } = setup(t);
  terminal.openDialog('assignment');
  terminal.element('new-mode').value = 'endless';
  terminal.element('new-difficulty').value = 'quarter_refiner';
  terminal.element('new-file').value = 'Siena';
  await terminal.startAssignment();
  assert.deepEqual(calls[0], ['create', 'endless', 'quarter_refiner', 'Siena']);
  assert.equal(terminal.element('terminal-dialog').open, false);
  api.create = async () => {
    throw new Error('Unavailable');
  };
  terminal.openDialog('assignment');
  await terminal.startAssignment();
  assert.equal(terminal.element('terminal-dialog').open, true);
  assert.equal(terminal.state.file, 'Cold Harbor');
});

test('RefinementTerminal.applyState restores saved camera and replacements only when changing files', (t) => {
  const { terminal, store, field } = setup(t);
  store.saveView('file-one', { camera: { x: 4000, y: 3000, zoom: 2 }, replacements: [[20608, 7]] });
  terminal.applyState(envelope());
  assert.deepEqual(field.camera.snapshot(), { x: 4000, y: 3000, zoom: 2 });
  assert.equal(field.replacements.get(20608), 7);
  field.camera.pan(30, 20);
  const camera = field.camera.snapshot();
  terminal.applyState(envelope({ score: 10 }));
  assert.deepEqual(field.camera.snapshot(), camera);
  terminal.applyState(envelope({ id: 'file-two' }));
  assert.deepEqual(field.camera.snapshot(), { x: 4608, y: 3360, zoom: 1 });
  assert.equal(field.replacements.size, 0);
});

test('RefinementTerminal.applyState formats positive negative zero feedback and archives each closure once', (t) => {
  const { terminal, audio, store } = setup(t);
  terminal.applyState(envelope({}, { accepted: true, message: 'Captured.', points: 34 }));
  assert.equal(terminal.element('feedback').textContent, 'CAPTURED. +34 PTS');
  terminal.applyState(envelope({}, { accepted: false, message: 'Penalty.', points: -50 }));
  assert.equal(terminal.element('feedback').textContent, 'PENALTY. -50 PTS');
  terminal.applyState(envelope({}, { accepted: false, message: 'Harmless.', points: 0 }));
  assert.equal(terminal.element('feedback').textContent, 'HARMLESS.');
  terminal.applyState(envelope({ status: 'completed', progress: 100, refined_digits: 500 }));
  assert.equal(store.history().length, 1);
  assert.ok(audio.played.includes('complete'));
  assert.match(terminal.element('result-summary').textContent, /QUOTA MET/);
  terminal.closeDialog();
  terminal.applyState(envelope({ status: 'completed', progress: 100 }));
  assert.equal(terminal.element('terminal-dialog').open, false);
  terminal.applyState(envelope({ id: 'failed-file', status: 'failed' }));
  assert.equal(store.history().length, 2);
  assert.equal(audio.played.at(-1), 'reject');
  assert.match(terminal.element('result-summary').textContent, /SHIFT HAS ENDED/);
});

test('RefinementTerminal.render presents modes difficulty score quotas and bin counts', (t) => {
  const { terminal } = setup(t);
  const state = envelope({
    mode: 'endless',
    difficulty: 'quarter_refiner',
    cycle: 4,
    mistakes: 2,
    score: 98,
    progress: 34.5,
  }).state;
  state.bins[0] = { id: 1, count: 23, capacity: 100, progress: 23 };
  terminal.state = state;
  terminal.render();
  assert.equal(
    terminal.element('assignment-label').textContent,
    'ENDLESS / CYCLE 4 / QUARTER REFINER / 2 OF 3 STRIKES',
  );
  assert.equal(terminal.element('score').textContent, '000098 PTS');
  assert.equal(terminal.element('completion').textContent, '34% COMPLETE');
  assert.equal(terminal.element('overall-progress').value, 34.5);
  assert.equal(terminal.element('bin-count-1').textContent, '023 / 100');
  assert.equal(terminal.element('bin-progress-1').value, 23);
  terminal.state = envelope({
    mode: 'timed',
    difficulty: 'quota_achiever',
    remaining_seconds: 900,
  }).state;
  terminal.render();
  assert.equal(terminal.element('assignment-label').textContent, 'TIMED SHIFT / QUOTA ACHIEVER');
});

test('RefinementTerminal.renderCamera displays zoom coordinates and position rectangle without revealing signals', (t) => {
  const { terminal, field, canvasCalls } = setup(t);
  field.camera.restore({ x: 4608, y: 3360, zoom: 2 });
  terminal.renderCamera();
  assert.equal(terminal.element('zoom-label').textContent, '200%');
  assert.equal(terminal.element('sector').textContent, '128:080');
  assert.equal(terminal.element('coordinates').textContent, '0x0080 : 0x0050');
  assert.equal(canvasCalls.at(-1).length, 4);
});

test('RefinementTerminal.renderClock counts timed shifts and refreshes at deadline only when eligible', (t) => {
  const { terminal } = setup(t);
  terminal.renderClock(1000);
  terminal.state = envelope().state;
  terminal.renderClock(1000);
  assert.equal(terminal.element('run-clock').textContent, 'UNTIMED');
  terminal.state.status = 'failed';
  terminal.renderClock(1000);
  assert.equal(terminal.element('run-clock').textContent, 'FILE CLOSED');
  terminal.state = envelope({ mode: 'timed', remaining_seconds: 70 }).state;
  terminal.receivedAt = 1000;
  terminal.renderClock(11000);
  assert.equal(terminal.element('run-clock').textContent, '01:00');
  const connect = t.mock.method(terminal, 'connect', () => {});
  terminal.renderClock(80000);
  assert.equal(connect.mock.callCount(), 1);
  terminal.busy = true;
  terminal.renderClock(80000);
  terminal.busy = false;
  terminal.retry = () => {};
  terminal.renderClock(80000);
  terminal.retry = null;
  terminal.state.status = 'failed';
  terminal.renderClock(80000);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(terminal.element('run-clock').textContent, '01:10');
});

test('RefinementTerminal.notify displays terminal uppercase while preserving readable accessible announcements', (t) => {
  const { terminal } = setup(t);
  terminal.notify('A signal is ready.');
  assert.equal(terminal.element('feedback').textContent, 'A SIGNAL IS READY.');
  assert.equal(terminal.element('announcer').textContent, 'A signal is ready.');
});

test('RefinementTerminal.pointerDown handles primary mouse touch gathering and multitouch release', (t) => {
  const { terminal, field, clock } = setup(t);
  terminal.applyState(envelope());
  terminal.pointerDown(pointer({ button: 2 }));
  assert.equal(terminal.pointers.size, 0);
  let captured;
  terminal.canvas.setPointerCapture = (id) => {
    captured = id;
  };
  terminal.pointerDown(pointer());
  assert.equal(captured, 1);
  assert.equal(terminal.gesture.multi, false);
  terminal.pointerCancel(pointer());
  const p = field.basePosition(20608, clock.value);
  terminal.pointerDown(pointer({ pointerType: 'touch', clientX: p.x, clientY: p.y }));
  assert.ok(field.motion);
  terminal.pointerDown(pointer({ pointerId: 2, pointerType: 'touch' }));
  assert.equal(terminal.gesture.multi, true);
  assert.equal(field.motion.releasedAt, clock.value);
  terminal.pointerCancel(pointer());
  terminal.pointerCancel(pointer({ pointerId: 2 }));
  terminal.busy = true;
  terminal.pointerDown(pointer({ pointerType: 'touch', clientX: p.x, clientY: p.y }));
  assert.equal(field.motion.releasedAt, clock.value);
});

test('RefinementTerminal.pointerMove hovers only active unobstructed idle fields and separates tiny moves from dragging', (t) => {
  const { terminal, field, clock } = setup(t);
  const hover = t.mock.method(field, 'hover', () => {});
  terminal.pointerMove(pointer());
  terminal.applyState(envelope());
  terminal.pointerMove(pointer());
  assert.equal(hover.mock.callCount(), 1);
  terminal.busy = true;
  terminal.pointerMove(pointer());
  terminal.busy = false;
  terminal.openDialog('help');
  terminal.pointerMove(pointer());
  terminal.closeDialog();
  terminal.state.status = 'failed';
  terminal.pointerMove(pointer());
  terminal.state.status = 'active';
  assert.equal(hover.mock.callCount(), 1);
  const before = field.camera.snapshot();
  terminal.pointerDown(pointer());
  terminal.pointerMove(pointer({ clientX: 503 }));
  assert.equal(terminal.gesture.dragged, false);
  terminal.pointerMove(pointer({ clientX: 520 }));
  assert.equal(terminal.gesture.dragged, true);
  assert.equal(terminal.canvas.classList.contains('dragging'), true);
  assert.equal(field.camera.x, before.x - 17);
  assert.equal(clock.value, 1000);
});

test('RefinementTerminal.pointerMove pans and zooms pinch gestures without dividing by zero or refining the remaining finger', (t) => {
  const { terminal, field } = setup(t);
  terminal.pointerDown(pointer({ pointerType: 'touch', clientX: 400 }));
  terminal.pointerDown(pointer({ pointerType: 'touch', pointerId: 2, clientX: 600 }));
  terminal.pointerMove(pointer({ pointerType: 'touch', pointerId: 2, clientX: 700 }));
  assert.equal(field.camera.zoom, 1.5);
  assert.equal(terminal.gesture.dragged, true);
  terminal.pointerUp(pointer({ pointerId: 2, pointerType: 'touch' }));
  const camera = field.camera.snapshot();
  terminal.pointerMove(pointer({ pointerType: 'touch', clientX: 450 }));
  assert.deepEqual(field.camera.snapshot(), camera);
  terminal.pointerCancel(pointer());
  terminal.pointerDown(pointer({ pointerType: 'touch' }));
  terminal.pointerDown(pointer({ pointerId: 2, pointerType: 'touch' }));
  terminal.pointerMove(pointer({ pointerType: 'touch' }));
  assert.equal(field.camera.zoom, 1.5);
  terminal.pointerMove(pointer({ pointerId: 2, pointerType: 'touch', clientX: 600 }));
  terminal.pointerMove(pointer({ pointerId: 2, pointerType: 'touch', clientX: 500 }));
  assert.ok(Number.isFinite(field.camera.zoom));
  terminal.pointers.clear();
  terminal.pointers.set(1, { x: 500, y: 350 });
  terminal.gesture = null;
  terminal.pointerMove(pointer());
});

test('RefinementTerminal.pointerUp refines simple clicks saves on final release and ignores unknown pointers', (t) => {
  const { terminal, field, clock } = setup(t);
  terminal.applyState(envelope());
  const refine = t.mock.method(terminal, 'refine', () => {});
  terminal.pointerUp(pointer());
  assert.equal(refine.mock.callCount(), 0);
  terminal.pointerDown(pointer());
  terminal.pointerUp(pointer());
  assert.deepEqual(refine.mock.calls[0].arguments, [500, 350]);
  assert.equal(terminal.gesture, null);
  const p = field.basePosition(20608, clock.value);
  terminal.pointerDown(pointer({ pointerType: 'touch', clientX: p.x, clientY: p.y }));
  terminal.pointerUp(pointer({ pointerType: 'touch', clientX: p.x, clientY: p.y }));
  assert.equal(field.motion.releasedAt, clock.value);
  terminal.pointerDown(pointer());
  terminal.pointerMove(pointer({ clientX: 550 }));
  terminal.pointerUp(pointer());
  assert.equal(refine.mock.callCount(), 2);
  assert.equal(terminal.canvas.classList.contains('dragging'), false);
});

test('RefinementTerminal.pointerCancel cancels gathering and prevents surviving touches from refining', (t) => {
  const { terminal } = setup(t);
  terminal.pointerCancel(pointer());
  terminal.pointerDown(pointer({ pointerType: 'touch' }));
  terminal.pointerDown(pointer({ pointerId: 2, pointerType: 'touch' }));
  terminal.pointerCancel(pointer());
  assert.equal(terminal.pointers.size, 1);
  assert.equal(terminal.gesture.multi, true);
  terminal.pointerCancel(pointer({ pointerId: 2 }));
  assert.equal(terminal.pointers.size, 0);
  assert.equal(terminal.gesture, null);
});

test('RefinementTerminal.wheel zooms at cursor and prevents page scrolling with bounded deltas', (t) => {
  const { terminal, field } = setup(t);
  const before = field.camera.screenToWorld(350, 250);
  let prevented = false;
  terminal.wheel({
    deltaY: -100,
    clientX: 350,
    clientY: 250,
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.ok(field.camera.zoom > 1);
  const after = field.camera.screenToWorld(350, 250);
  assert.ok(Math.abs(before.x - after.x) < 1e-8 && Math.abs(before.y - after.y) < 1e-8);
});

test('RefinementTerminal.zoom preserves viewport center and saves the new camera', (t) => {
  const { terminal, field, store } = setup(t);
  terminal.applyState(envelope());
  const before = field.camera.snapshot();
  terminal.zoom(2);
  assert.deepEqual(field.camera.snapshot(), { ...before, zoom: 2 });
  assert.equal(store.view('file-one').camera.zoom, 2);
});

test('RefinementTerminal.keydown handles navigation zoom visible signals refinement and help without hijacking form inputs', (t) => {
  const { terminal, field } = setup(t);
  terminal.applyState(envelope());
  for (const [key, dx, dy] of [
    ['ArrowLeft', -90, 0],
    ['d', 90, 0],
    ['w', 0, -90],
    ['s', 0, 90],
  ]) {
    const before = field.camera.snapshot(),
      event = keyEvent(terminal, key);
    terminal.keydown(event);
    assert.equal(event.prevented, true);
    assert.equal(field.camera.x, before.x + dx);
    assert.equal(field.camera.y, before.y + dy);
  }
  const zoom = t.mock.method(terminal, 'zoom', () => {}),
    signal = t.mock.method(terminal, 'focusSignal', () => {}),
    refine = t.mock.method(terminal, 'refine', () => {});
  for (const key of ['+', '=', '-']) terminal.keydown(keyEvent(terminal, key));
  assert.deepEqual(
    zoom.mock.calls.map((call) => call.arguments[0]),
    [1.25, 1.25, 0.8],
  );
  terminal.keydown(keyEvent(terminal, 'f'));
  assert.equal(signal.mock.callCount(), 1);
  for (const key of ['Enter', ' ']) terminal.keydown(keyEvent(terminal, key));
  assert.equal(refine.mock.callCount(), 2);
  terminal.keydown(keyEvent(terminal, 'x'));
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']) {
    const event = keyEvent(terminal, 'f', { tagName });
    terminal.keydown(event);
    assert.equal(event.prevented, false);
  }
  terminal.keydown(keyEvent(terminal, '?'));
  assert.equal(terminal.element('help-panel').hidden, false);
  terminal.keydown(keyEvent(terminal, 'f'));
  assert.equal(signal.mock.callCount(), 1);
});

test('RefinementTerminal.keydown preserves browser modifier shortcuts while allowing shifted gameplay keys', (t) => {
  const { terminal, field } = setup(t);
  terminal.applyState(envelope());
  const camera = field.camera.snapshot();
  const zoom = t.mock.method(terminal, 'zoom', () => {});
  const signal = t.mock.method(terminal, 'focusSignal', () => {});
  const refine = t.mock.method(terminal, 'refine', () => {});
  const open = t.mock.method(terminal, 'openDialog', () => {});
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    for (const key of ['f', 'w', 'ArrowLeft', '+', '-', 'Enter', '?']) {
      const event = Object.assign(keyEvent(terminal, key), { [modifier]: true });
      terminal.keydown(event);
      assert.equal(event.prevented, false, `${modifier} + ${key} must remain a browser shortcut`);
    }
  }
  assert.deepEqual(field.camera.snapshot(), camera);
  for (const spy of [zoom, signal, refine, open]) assert.equal(spy.mock.callCount(), 0);

  const plus = Object.assign(keyEvent(terminal, '+'), { shiftKey: true });
  terminal.keydown(plus);
  assert.equal(plus.prevented, true);
  assert.deepEqual(zoom.mock.calls[0].arguments, [1.25]);
  terminal.keydown(Object.assign(keyEvent(terminal, '?'), { shiftKey: true }));
  assert.deepEqual(open.mock.calls[0].arguments, ['help']);
});

test('RefinementTerminal.focusSignal cycles only visible active clusters and explains an empty viewport', (t) => {
  const { terminal, field } = setup(t);
  terminal.focusSignal();
  terminal.applyState(envelope());
  terminal.busy = true;
  terminal.focusSignal();
  terminal.busy = false;
  terminal.state.status = 'failed';
  terminal.focusSignal();
  terminal.state.status = 'active';
  terminal.focusSignal();
  assert.equal(field.motion.cluster.id, '0:0');
  terminal.focusSignal();
  assert.equal(field.motion.cluster.id, '1:0');
  terminal.focusSignal();
  assert.equal(field.motion.cluster.id, '0:0');
  assert.match(terminal.element('feedback').textContent, /VISIBLE SIGNAL FOCUSED/);
  field.camera.restore({ x: 8000, y: 5000, zoom: 3 });
  terminal.focusSignal();
  assert.match(terminal.element('feedback').textContent, /NO SIGNAL IN THIS VIEWPORT/);
});

test('RefinementTerminal.refine gates unfinished gathering then captures through the authoritative API', async (t) => {
  const { terminal, field, clock, calls } = setup(t);
  terminal.applyState(envelope());
  terminal.focusSignal();
  terminal.refine();
  assert.match(terminal.element('feedback').textContent, /EARLY CLICKS CARRY NO PENALTY/);
  assert.deepEqual(calls, []);
  clock.value += 1500;
  terminal.refine();
  await settle();
  assert.deepEqual(calls[0], ['capture', 'signed-token', '0:0']);
  assert.equal(field.replacements.size, 3);
});

test('RefinementTerminal.refine handles inactive dialogs absent coordinates scary hits ordinary hits and gaps', async (t) => {
  const { terminal, field, clock, calls } = setup(t);
  terminal.refine();
  terminal.applyState(envelope());
  terminal.busy = true;
  terminal.refine();
  terminal.busy = false;
  terminal.openDialog('help');
  terminal.refine();
  terminal.closeDialog();
  const focus = t.mock.method(terminal, 'focusSignal', () => {});
  terminal.refine();
  terminal.refine(100, NaN);
  assert.equal(focus.mock.callCount(), 2);
  const scary = field.basePosition(20608, clock.value);
  terminal.refine(scary.x, scary.y);
  assert.equal(field.motion.cluster.id, '0:0');
  field.motion = null;
  const ordinary = field.basePosition(20610, clock.value);
  terminal.refine(ordinary.x, ordinary.y);
  await settle();
  assert.deepEqual(calls[0], ['mistake', 'signed-token', 20610]);
  terminal.refine(-10000, -10000);
  assert.equal(calls.length, 1);
});

test('RefinementTerminal.saveView persists camera and replacement map only with a loaded file', (t) => {
  const { terminal, field, store } = setup(t);
  terminal.saveView();
  assert.equal(store.get('view', null), null);
  terminal.applyState(envelope());
  field.replacements.set(30, 7);
  terminal.saveView();
  assert.deepEqual(store.view('file-one').replacements, [[30, 7]]);
});

test('RefinementTerminal.configure persists audio and motion controls and applies their behavior', (t) => {
  const { terminal, store, field, audio } = setup(t);
  terminal.element('sound-setting').checked = true;
  terminal.element('motion-setting').checked = true;
  terminal.configure();
  assert.deepEqual(store.preferences(), { sound: true, reducedMotion: true });
  assert.equal(field.reducedMotion, true);
  assert.equal(audio.enabled, true);
});

test('RefinementTerminal.openDialog selects panels initializes choices and safely renders local history', (t) => {
  const { terminal, store } = setup(t);
  terminal.openDialog('assignment');
  assert.equal(terminal.element('terminal-dialog').open, true);
  assert.equal(terminal.element('dialog-title').textContent, 'FILE ASSIGNMENT');
  terminal.applyState(envelope({ mode: 'endless', difficulty: 'quota_achiever' }));
  terminal.openDialog('assignment');
  assert.equal(terminal.element('new-mode').value, 'endless');
  assert.equal(terminal.element('new-difficulty').value, 'quota_achiever');
  terminal.openDialog('history');
  assert.match(terminal.element('history-list').textContent, /NO CLOSED FILES/);
  store.archive(
    envelope({ id: 'closed', status: 'failed', file: '<img src=x onerror=alert(1)>', score: 123 })
      .state,
  );
  terminal.openDialog('history');
  assert.match(terminal.element('history-list').textContent, /123 PTS/);
  assert.equal(terminal.element('history-list').querySelector('img'), null);
  assert.equal(terminal.element('assignment-panel').hidden, true);
});

test('RefinementTerminal.openDialog clears old inline request errors when selecting a new panel', (t) => {
  const { terminal } = setup(t);
  const alert = terminal.element('dialog-feedback');
  alert.textContent = 'Previous request failed.';
  terminal.openDialog('assignment');
  assert.equal(alert.textContent, '');
  alert.textContent = 'Another stale error.';
  terminal.openDialog('help');
  assert.equal(alert.textContent, '');
  assert.equal(terminal.element('help-panel').hidden, false);
});

test('RefinementTerminal.closeDialog closes the overlay and returns focus to the field', (t) => {
  const { terminal, document } = setup(t);
  terminal.openDialog('help');
  terminal.closeDialog();
  assert.equal(terminal.element('terminal-dialog').open, false);
  assert.equal(document.activeElement, terminal.canvas);
});

test('RefinementTerminal.destroy saves progress removes listeners clears motion and stops scheduled drawing', async (t) => {
  const { terminal, window, field, audio, store, animations } = setup(t);
  await terminal.init();
  field.replacements.set(3, 4);
  terminal.pointers.set(1, {});
  const animation = terminal.animation;
  terminal.destroy();
  assert.equal(terminal.destroyed, true);
  assert.deepEqual(terminal.listeners, []);
  assert.equal(terminal.pointers.size, 0);
  assert.equal(field.replacements.size, 0);
  assert.equal(audio.disposed, true);
  assert.equal(animations.has(animation), false);
  assert.deepEqual(store.view('file-one').replacements, [[3, 4]]);
  const resize = t.mock.method(terminal, 'resize', () => {});
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(resize.mock.callCount(), 0);
});
