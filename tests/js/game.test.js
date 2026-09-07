import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  ApiClient,
  SessionStore,
  SoundEngine,
  RefinementTerminal,
} from '../../public/assets/game.js';

const fixture = readFileSync(new URL('../../templates/index.html', import.meta.url), 'utf8');

function response(overrides = {}) {
  return {
    token: 'signed-file-token',
    state: {
      id: 'file-one',
      file: 'Cold Harbor',
      mode: 'standard',
      status: 'active',
      score: 0,
      streak: 0,
      mistakes: 0,
      max_mistakes: 5,
      progress: 0,
      round: 1,
      rounds: 4,
      elapsed_seconds: 0,
      remaining_seconds: null,
      bins: [1, 2, 3, 4, 5].map((id) => ({ id, progress: 0, count: 0, capacity: 4 })),
      board: {
        columns: 20,
        rows: 10,
        cells: Array.from({ length: 200 }, (_, id) => ({ id, value: id % 10 })),
        clusters: [21, 26, 31, 101, 106].map((id, index) => ({
          id: `cluster-${index}`,
          cells: [id, id + 1, id + 20, id + 21],
          bin: index + 1,
          temper: ['WO', 'FC', 'DR', 'MA', 'WO'][index],
          collected: false,
        })),
      },
      ...overrides,
    },
  };
}

function setup(t, options = {}) {
  const dom = new JSDOM(fixture, { url: 'https://refinement.example/', pretendToBeVisual: true });
  const calls = [];
  const api = {
    create: async (...args) => {
      calls.push(['create', ...args]);
      return response();
    },
    restore: async (...args) => {
      calls.push(['restore', ...args]);
      return response();
    },
    refine: async (...args) => {
      calls.push(['refine', ...args]);
      return {
        ...response({ score: 100, streak: 1 }),
        feedback: { accepted: true, message: 'Numbers refined.' },
      };
    },
    ...options.api,
  };
  const sound = {
    enabled: false,
    played: [],
    disposed: false,
    setEnabled(value) {
      this.enabled = value;
    },
    play(value) {
      this.played.push(value);
    },
    dispose() {
      this.disposed = true;
    },
  };
  const clock = { value: 100000 };
  const store = options.store || new SessionStore(dom.window.localStorage);
  const terminal = new RefinementTerminal(dom.window.document, dom.window, {
    api,
    sound,
    store,
    now: () => clock.value,
  });
  t.after(() => {
    terminal.destroy();
    dom.window.close();
  });
  return {
    dom,
    terminal,
    api,
    sound,
    clock,
    store,
    calls,
    document: dom.window.document,
    window: dom.window,
  };
}

function apiFixture(result = response(), status = 200) {
  const calls = [];
  return {
    calls,
    client: new ApiClient(async (...args) => {
      calls.push(args);
      return { ok: status < 400, status, json: async () => result };
    }),
  };
}

test('ApiClient.constructor accepts an injected transport and defaults to browser fetch', () => {
  const transport = () => {};
  assert.equal(new ApiClient(transport).fetcher, transport);
  assert.equal(typeof new ApiClient().fetcher, 'function');
});

test('ApiClient.request posts JSON with caching disabled and returns validated state', async () => {
  const { client, calls } = apiFixture();
  assert.equal((await client.request('restore', { token: 'saved' })).token, 'signed-file-token');
  assert.equal(calls[0][0], '/api/restore');
  const { signal, ...options } = calls[0][1];
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(options, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"token":"saved"}',
    cache: 'no-store',
  });
});

test('ApiClient.request explains transport errors, HTTP errors, malformed JSON and missing state', async () => {
  await assert.rejects(
    new ApiClient(async () => {
      throw new Error('offline');
    }).request('session', {}),
    /saved file is safe/,
  );
  await assert.rejects(apiFixture({ detail: 'Expired token' }, 410).client.request('restore', {}), {
    message: 'Expired token',
    status: 410,
  });
  await assert.rejects(
    apiFixture({ error: 'No assignment' }, 404).client.request('restore', {}),
    /No assignment/,
  );
  await assert.rejects(
    apiFixture({ detail: [] }, 422).client.request('restore', {}),
    /could not be completed/,
  );
  const malformed = new ApiClient(async () => ({
    ok: true,
    json: async () => {
      throw new Error('bad json');
    },
  }));
  await assert.rejects(malformed.request('session', {}), /unreadable response/);
  await assert.rejects(
    apiFixture({ token: 'missing-state' }).client.request('session', {}),
    /incomplete file/,
  );
});

test('ApiClient.create sends selected file and mode and supplies playable defaults', async () => {
  const { client, calls } = apiFixture();
  await client.create();
  await client.create('orientation', 'Siena');
  assert.equal(calls[0][0], '/api/session');
  assert.deepEqual(JSON.parse(calls[0][1].body), { mode: 'standard', file: 'Cold Harbor' });
  assert.deepEqual(JSON.parse(calls[1][1].body), { mode: 'orientation', file: 'Siena' });
});

test('ApiClient.restore sends the saved signed token', async () => {
  const { client, calls } = apiFixture();
  await client.restore('private-token');
  assert.equal(calls[0][0], '/api/restore');
  assert.deepEqual(JSON.parse(calls[0][1].body), { token: 'private-token' });
});

test('ApiClient.refine sends the exact selection and destination', async () => {
  const { client, calls } = apiFixture();
  await client.refine('private-token', [21, 22, 41, 42], 1);
  assert.equal(calls[0][0], '/api/refine');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    token: 'private-token',
    cells: [21, 22, 41, 42],
    bin: 1,
  });
});

test('SessionStore.constructor supports missing persistent storage', () => {
  const store = new SessionStore(null);
  assert.equal(store.storage, null);
  assert.equal(store.memory.size, 0);
});

test('SessionStore.get handles absent, malformed and inaccessible storage', () => {
  assert.equal(new SessionStore(null).get('unknown', 42), 42);
  assert.deepEqual(new SessionStore({ getItem: () => '{"sound":true}' }).get('preferences', {}), {
    sound: true,
  });
  assert.equal(new SessionStore({ getItem: () => 'invalid json' }).get('session', null), null);
  const store = new SessionStore({
    getItem: () => {
      throw new Error('denied');
    },
  });
  store.memory.set('session', 'in-memory');
  assert.equal(store.get('session', null), 'in-memory');
});

test('SessionStore.set writes namespaced JSON and preserves an in-memory fallback', () => {
  const writes = [];
  const store = new SessionStore({ setItem: (...args) => writes.push(args) });
  store.set('session', 'signed');
  assert.deepEqual(writes, [['mdr.session', '"signed"']]);
  assert.equal(store.memory.get('session'), 'signed');
  const unavailable = new SessionStore({
    setItem: () => {
      throw new Error('quota');
    },
  });
  unavailable.set('session', 'safe');
  assert.equal(unavailable.memory.get('session'), 'safe');
});

test('SessionStore.token accepts only string tokens', () => {
  const store = new SessionStore(null);
  assert.equal(store.token(), null);
  store.set('session', { fake: true });
  assert.equal(store.token(), null);
  store.set('session', 'token');
  assert.equal(store.token(), 'token');
});

test('SessionStore.saveToken updates and clears the saved assignment', () => {
  const store = new SessionStore(null);
  store.saveToken('token');
  assert.equal(store.token(), 'token');
  store.saveToken(null);
  assert.equal(store.token(), null);
});

test('SessionStore.preferences validates values and defaults sound and motion preferences off', () => {
  const store = new SessionStore(null);
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
  store.set('preferences', { sound: 'yes', reducedMotion: true });
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: true });
  store.set('preferences', null);
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
});

test('SessionStore.savePreferences persists only recognized boolean preferences', () => {
  const store = new SessionStore(null);
  store.savePreferences({ sound: 1, reducedMotion: 0, extra: 'ignore' });
  assert.deepEqual(store.get('preferences'), { sound: true, reducedMotion: false });
});

test('SessionStore.history tolerates corrupt archives and removes malformed rows', () => {
  const store = new SessionStore(null);
  store.set('history', {});
  assert.deepEqual(store.history(), []);
  store.set('history', [null, { id: 2 }, { id: 'valid' }]);
  assert.deepEqual(store.history(), [{ id: 'valid' }]);
});

test('SessionStore.archive stores closed files once and limits browser history to 30', () => {
  const store = new SessionStore(null);
  store.archive(response().state);
  assert.equal(store.history().length, 0);
  for (let index = 0; index < 35; index += 1)
    store.archive(
      response({ id: `file-${index}`, status: index % 2 ? 'completed' : 'failed' }).state,
    );
  store.archive(response({ id: 'file-34', status: 'failed' }).state);
  assert.equal(store.history().length, 30);
  assert.equal(store.history()[0].id, 'file-34');
  assert.equal(store.history()[29].id, 'file-5');
  assert.ok(!Number.isNaN(Date.parse(store.history()[0].completedAt)));
  assert.equal(store.history()[0].token, undefined);
});

test('SoundEngine.constructor starts silent without opening an audio device', () => {
  const engine = new SoundEngine({});
  assert.equal(engine.enabled, false);
  assert.equal(engine.context, null);
});

test('SoundEngine.setEnabled explicitly enables and disables procedural sound', () => {
  const engine = new SoundEngine({});
  engine.setEnabled(true);
  assert.equal(engine.enabled, true);
  engine.setEnabled(0);
  assert.equal(engine.enabled, false);
});

test('SoundEngine.play creates a quiet short oscillator only on demand and reuses its context', async () => {
  const events = [];
  let constructed = 0;
  class FakeAudioContext {
    constructor() {
      constructed += 1;
      this.currentTime = 10;
      this.state = 'suspended';
      this.destination = 'speakers';
    }
    resume() {
      events.push('resume');
      return Promise.resolve();
    }
    createOscillator() {
      return {
        frequency: { setValueAtTime: (...args) => events.push(['frequency', ...args]) },
        connect: () => {},
        start: () => events.push('start'),
        stop: (at) => events.push(['stop', at]),
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: (...args) => events.push(['volume', ...args]),
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
      };
    }
  }
  const engine = new SoundEngine({ AudioContext: FakeAudioContext });
  engine.play();
  assert.equal(constructed, 0);
  engine.setEnabled(true);
  engine.play('accepted');
  engine.play('unknown');
  assert.equal(constructed, 1);
  assert.ok(
    events.some((event) => Array.isArray(event) && event[0] === 'frequency' && event[1] === 720),
  );
  assert.ok(
    events.some((event) => Array.isArray(event) && event[0] === 'frequency' && event[1] === 340),
  );
  assert.ok(
    events.some((event) => Array.isArray(event) && event[0] === 'volume' && event[1] < 0.05),
  );
  assert.ok(
    events.some((event) => Array.isArray(event) && event[0] === 'stop' && event[1] === 10.18),
  );
  const unsupported = new SoundEngine({});
  unsupported.setEnabled(true);
  assert.doesNotThrow(() => unsupported.play());
  const restricted = new SoundEngine({
    AudioContext: class {
      constructor() {
        throw new Error('blocked');
      }
    },
  });
  restricted.setEnabled(true);
  assert.doesNotThrow(() => restricted.play());
  await Promise.resolve();
});

test('SoundEngine.dispose releases audio and tolerates closed or absent contexts', async () => {
  const engine = new SoundEngine({});
  engine.dispose();
  let closed = false;
  engine.context = {
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  engine.dispose();
  assert.equal(closed, true);
  assert.equal(engine.context, null);
  engine.context = {
    close: () => {
      throw new Error('closed');
    },
  };
  assert.doesNotThrow(() => engine.dispose());
  await Promise.resolve();
});

test('RefinementTerminal.constructor initializes isolated state and injected collaborators', (t) => {
  const { terminal, api, store, sound } = setup(t);
  assert.equal(terminal.api, api);
  assert.equal(terminal.store, store);
  assert.equal(terminal.sound, sound);
  assert.equal(terminal.state, null);
  assert.equal(terminal.pending, false);
  assert.equal(terminal.selection.size, 0);
});

test('RefinementTerminal.constructor supplies production collaborators when storage is blocked', (t) => {
  const { document, window } = setup(t);
  window.fetch = async () => {};
  Object.defineProperty(window, 'localStorage', {
    get() {
      throw new Error('disabled');
    },
  });
  const terminal = new RefinementTerminal(document, window);
  assert.ok(terminal.api instanceof ApiClient);
  assert.ok(terminal.sound instanceof SoundEngine);
  assert.equal(terminal.store.storage, null);
  assert.equal(terminal.now, Date.now);
  terminal.destroy();
});

test('RefinementTerminal.element resolves terminal DOM elements', (t) => {
  const { terminal, document } = setup(t);
  assert.equal(terminal.element('number-grid'), document.getElementById('number-grid'));
  assert.equal(terminal.element('missing'), null);
});

test('RefinementTerminal.init starts a playable default file and wires controls', async (t) => {
  const { terminal, calls, document, sound } = setup(t);
  assert.equal(await terminal.init(), true);
  assert.deepEqual(calls[0], ['create', 'standard', 'Cold Harbor']);
  assert.equal(document.querySelectorAll('[data-cell]').length, 200);
  assert.equal(sound.enabled, false);
  document.querySelector('[data-cell="21"]').click();
  assert.deepEqual([...terminal.selection], [21, 22, 41, 42]);
  document.getElementById('clear-button').click();
  assert.equal(terminal.selection.size, 0);
  document.getElementById('sound-button').click();
  assert.equal(sound.enabled, true);
  for (const id of ['help', 'settings', 'archive', 'new-file']) {
    document.getElementById(`${id}-button`).click();
    assert.equal(document.getElementById('modal').open, true);
    document.getElementById('modal-close').click();
  }
  document.getElementById('scan-button').click();
  assert.equal(terminal.scanned.size, 4);
});

test('RefinementTerminal.init restores saved files, replaces expired tokens, and preserves offline saves', async (t) => {
  const store = new SessionStore(null);
  store.saveToken('saved-token');
  const restored = setup(t, { store });
  assert.equal(await restored.terminal.init(), true);
  assert.deepEqual(restored.calls, [['restore', 'saved-token']]);
  const expiredStore = new SessionStore(null);
  expiredStore.saveToken('expired');
  const expired = setup(t, {
    store: expiredStore,
    api: {
      restore: async () => {
        throw Object.assign(new Error('expired'), { status: 410 });
      },
    },
  });
  assert.equal(await expired.terminal.init(), true);
  assert.deepEqual(expired.calls[0], ['create', 'standard', 'Cold Harbor']);
  const offlineStore = new SessionStore(null);
  offlineStore.saveToken('keep-me');
  const offline = setup(t, {
    store: offlineStore,
    api: {
      restore: async () => {
        throw new Error('offline');
      },
    },
  });
  assert.equal(await offline.terminal.init(), false);
  assert.equal(offlineStore.token(), 'keep-me');
  assert.equal(offline.calls.length, 0);
});

test('RefinementTerminal.init wires hover, focus, keyboard, dialog cancel and tab restoration', async (t) => {
  const { terminal, document, window, calls } = setup(t);
  await terminal.init();
  const cell = document.querySelector('[data-cell="21"]');
  cell.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
  assert.equal(terminal.hovered.size, 4);
  document.getElementById('number-grid').dispatchEvent(new window.Event('pointerleave'));
  assert.equal(terminal.hovered.size, 0);
  cell.focus();
  assert.equal(document.querySelectorAll('[data-cell][tabindex="0"]').length, 1);
  assert.equal(document.getElementById('coordinates').textContent, 'X:02 Y:02');
  cell.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(terminal.selection.size, 4);
  terminal.showHelp();
  const cancel = new window.Event('cancel', { cancelable: true });
  document.getElementById('modal').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(document.getElementById('modal').open, false);
  window.dispatchEvent(new window.Event('focus'));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(calls.some((entry) => entry[0] === 'restore'));
});

test('RefinementTerminal.destroy removes event listeners and stops timers and audio', async (t) => {
  const { terminal, document, sound } = setup(t);
  await terminal.init();
  terminal.destroy();
  document.querySelector('[data-cell="21"]').click();
  assert.equal(terminal.selection.size, 0);
  assert.equal(terminal.listeners.signal.aborted, true);
  assert.equal(sound.disposed, true);
});

test('RefinementTerminal.request locks concurrent actions, reports feedback and unlocks after success', async (t) => {
  const { terminal, document, sound } = setup(t);
  let finish;
  const waiting = terminal.request(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  assert.equal(terminal.pending, true);
  assert.equal(document.getElementById('new-file-button').disabled, true);
  assert.equal(await terminal.request(() => assert.fail('duplicate request')), false);
  finish({ ...response(), feedback: { accepted: false, message: 'Try a different group.' } });
  assert.equal(await waiting, true);
  assert.equal(terminal.pending, false);
  assert.equal(document.getElementById('connection-label').textContent, 'SYSTEM CONNECTED');
  assert.equal(document.getElementById('toast').textContent, 'Try a different group.');
  assert.ok(sound.played.includes('rejected'));
});

test('RefinementTerminal.request preserves the token and selection after connection failures', async (t) => {
  const { terminal, store, document } = setup(t);
  terminal.applyResponse(response());
  terminal.selectCell(21);
  assert.equal(
    await terminal.request(async () => {
      throw new Error('offline');
    }),
    false,
  );
  assert.equal(store.token(), 'signed-file-token');
  assert.equal(terminal.selection.size, 4);
  assert.equal(terminal.lastError.message, 'offline');
  assert.equal(terminal.pending, false);
  assert.equal(document.getElementById('bin-1').disabled, false);
  assert.match(document.getElementById('connection-label').textContent, /INTERRUPTED/);
});

test('RefinementTerminal.newSession sends the requested assignment and defaults', async (t) => {
  const { terminal, calls } = setup(t);
  await terminal.newSession('orientation', 'Siena');
  await terminal.newSession();
  assert.deepEqual(calls, [
    ['create', 'orientation', 'Siena'],
    ['create', 'standard', 'Cold Harbor'],
  ]);
});

test('RefinementTerminal.restore skips missing tokens and reloads saved assignments', async (t) => {
  const { terminal, calls } = setup(t);
  assert.equal(await terminal.restore(), false);
  terminal.token = 'resume-token';
  assert.equal(await terminal.restore(), true);
  assert.deepEqual(calls[0], ['restore', 'resume-token']);
});

test('RefinementTerminal.applyResponse saves state, resets selections and announces section advances', (t) => {
  const { terminal, store, clock, document } = setup(t);
  terminal.applyResponse(response());
  terminal.selectCell(21);
  terminal.scanUntil = 120000;
  clock.value += 2000;
  terminal.applyResponse({ ...response({ round: 2, progress: 25 }), token: 'next-token' });
  assert.equal(store.token(), 'next-token');
  assert.equal(terminal.receivedAt, 102000);
  assert.equal(terminal.selection.size, 0);
  assert.equal(terminal.scanUntil, 120000);
  assert.match(document.getElementById('toast').textContent, /Section 1 refined/);
  terminal.applyResponse(response({ id: 'new-file' }));
  assert.equal(terminal.scanUntil, 0);
});

test('RefinementTerminal.applyResponse archives final assignments and shows the reward only once', (t) => {
  const { terminal, store, document } = setup(t);
  terminal.applyResponse(response({ status: 'completed', progress: 100 }));
  assert.equal(store.history().length, 1);
  assert.equal(document.getElementById('modal').open, true);
  terminal.closeModal();
  terminal.applyResponse(response({ status: 'completed', progress: 100 }));
  assert.equal(document.getElementById('modal').open, false);
  assert.equal(store.history().length, 1);
});

test('RefinementTerminal.render creates 200 accessible cells and accurate progress, bins and status', (t) => {
  const { terminal, document } = setup(t);
  terminal.render();
  const payload = response({ score: 150, streak: 2, mistakes: 1, progress: 25, round: 2 });
  payload.state.bins[0] = { id: 1, progress: 100, count: 4, capacity: 4 };
  payload.state.board.clusters[0].collected = true;
  terminal.applyResponse(payload);
  assert.equal(document.querySelectorAll('[data-cell]').length, 200);
  assert.equal(document.querySelectorAll('.is-anomaly').length, 16);
  assert.equal(document.querySelectorAll('.is-collected').length, 4);
  assert.equal(document.querySelectorAll('[data-cell][tabindex="0"]').length, 1);
  assert.equal(document.getElementById('file-name').textContent, 'Cold Harbor');
  assert.equal(document.getElementById('mode-label').textContent, 'STANDARD REFINEMENT');
  assert.equal(document.getElementById('score-value').textContent, '0150');
  assert.equal(document.getElementById('streak-value').textContent, '02');
  assert.equal(document.getElementById('mistakes-value').textContent, '1 / 5');
  assert.equal(document.getElementById('round-value').textContent, '02 / 04');
  assert.equal(document.getElementById('file-progress').textContent, '25%');
  assert.equal(document.getElementById('overall-fill').style.width, '25%');
  assert.equal(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '25');
  assert.equal(document.querySelector('#bin-1 [data-bin-count]').textContent, '4 / 4');
  assert.equal(document.getElementById('bin-1').classList.contains('is-full'), true);
  assert.match(
    document.querySelector('[data-cell="26"]').getAttribute('aria-label'),
    /unusual pattern/,
  );
  document.querySelector('[data-cell="26"]').focus();
  terminal.render();
  assert.equal(document.activeElement.dataset.cell, '26');
  terminal.applyResponse(response({ mode: 'orientation', max_mistakes: null }));
  assert.equal(document.getElementById('mistakes-value').textContent, '0 / ∞');
});

test('RefinementTerminal.renderControls enforces pending, empty selection and scan cooldown', (t) => {
  const { terminal, document, clock } = setup(t);
  terminal.renderControls();
  assert.equal(document.getElementById('bin-1').disabled, true);
  terminal.applyResponse(response());
  terminal.setSelection([21, 22, 41, 42]);
  assert.equal(document.getElementById('bin-1').disabled, false);
  terminal.scanUntil = clock.value + 15000;
  terminal.pending = true;
  terminal.renderControls();
  assert.equal(document.getElementById('number-grid').getAttribute('aria-busy'), 'true');
  assert.equal(document.getElementById('clear-button').disabled, true);
  terminal.pending = false;
  terminal.renderControls();
  assert.equal(document.getElementById('scan-button').disabled, true);
  clock.value += 15000;
  terminal.renderControls();
  assert.equal(document.getElementById('scan-button').disabled, false);
});

test('RefinementTerminal.coordinates maps zero-indexed grid cells to readable coordinates', (t) => {
  const { terminal } = setup(t);
  assert.equal(terminal.coordinates(0), 'X:01 Y:01');
  terminal.applyResponse(response());
  assert.equal(terminal.coordinates(199), 'X:20 Y:10');
  assert.equal(terminal.coordinates(21), 'X:02 Y:02');
});

test('RefinementTerminal.clusterAt only returns uncollected patterns', (t) => {
  const { terminal } = setup(t);
  assert.equal(terminal.clusterAt(21), null);
  terminal.applyResponse(response());
  assert.equal(terminal.clusterAt(21).bin, 1);
  assert.equal(terminal.clusterAt(0), null);
  terminal.state.board.clusters[0].collected = true;
  assert.equal(terminal.clusterAt(21), null);
});

test('RefinementTerminal.matchingCluster requires exactly the four numbers in one active pattern', (t) => {
  const { terminal } = setup(t);
  assert.equal(terminal.matchingCluster(), null);
  terminal.applyResponse(response());
  terminal.setSelection([42, 41, 22, 21]);
  assert.equal(terminal.matchingCluster().bin, 1);
  terminal.setSelection([21, 22, 41]);
  assert.equal(terminal.matchingCluster(), null);
  terminal.setSelection([21, 22, 41, 42, 0]);
  assert.equal(terminal.matchingCluster(), null);
});

test('RefinementTerminal.selectCell toggles whole patterns and individual background numbers', (t) => {
  const { terminal, sound, document } = setup(t);
  terminal.selectCell(21);
  assert.equal(terminal.selection.size, 0);
  terminal.applyResponse(response());
  terminal.selectCell(21);
  assert.deepEqual([...terminal.selection], [21, 22, 41, 42]);
  assert.match(document.getElementById('selection-detail').textContent, /bin 01/);
  terminal.selectCell(22);
  assert.equal(terminal.selection.size, 0);
  terminal.selectCell(0);
  assert.deepEqual([...terminal.selection], [0]);
  terminal.selectCell(0);
  assert.equal(terminal.selection.size, 0);
  terminal.pending = true;
  terminal.selectCell(21);
  assert.equal(terminal.selection.size, 0);
  assert.equal(sound.played.filter((kind) => kind === 'select').length, 4);
});

test('RefinementTerminal.setSelection removes invalid, duplicate and already-refined numbers', (t) => {
  const { terminal } = setup(t);
  const payload = response();
  payload.state.board.clusters[0].collected = true;
  terminal.applyResponse(payload);
  terminal.scanned.add(26);
  terminal.setSelection([0, 0, 21, -1, 200, 26]);
  assert.deepEqual([...terminal.selection], [0, 26]);
  assert.equal(terminal.scanned.size, 0);
  terminal.pending = true;
  terminal.setSelection([]);
  assert.equal(terminal.selection.size, 2);
});

test('RefinementTerminal.renderSelection exposes selected, hovered, scanned and recommended states', (t) => {
  const { terminal, document } = setup(t);
  terminal.applyResponse(response());
  terminal.selection = new Set([21, 22, 41, 42]);
  terminal.hovered = new Set([26]);
  terminal.scanned = new Set([31]);
  terminal.renderSelection();
  assert.equal(document.querySelectorAll('.is-selected').length, 4);
  assert.equal(document.querySelector('[data-cell="21"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-cell="26"]').classList.contains('is-hovered'), true);
  assert.equal(document.querySelector('[data-cell="31"]').classList.contains('is-scanned'), true);
  assert.equal(document.getElementById('bin-1').classList.contains('is-recommended'), true);
  assert.equal(document.getElementById('selection-label').textContent, '4 NUMBERS SELECTED');
  assert.match(document.getElementById('announcement').textContent, /Send to bin 1/);
  terminal.setSelection([0]);
  assert.match(document.getElementById('selection-detail').textContent, /Pattern incomplete/);
  terminal.setSelection([]);
  assert.equal(document.getElementById('selection-label').textContent, 'AWAITING SELECTION');
});

test('RefinementTerminal.hover reveals only related pattern cells and updates coordinates', (t) => {
  const { terminal, document } = setup(t);
  terminal.applyResponse(response());
  terminal.hover(21);
  assert.deepEqual([...terminal.hovered], [21, 22, 41, 42]);
  assert.equal(document.getElementById('coordinates').textContent, 'X:02 Y:02');
  terminal.hover(null);
  assert.equal(terminal.hovered.size, 0);
  terminal.hover(0);
  assert.equal(terminal.hovered.size, 0);
});

test('RefinementTerminal.drag selects a rectangle in both directions and supports coordinate targeting', (t) => {
  const { terminal, document } = setup(t);
  terminal.applyResponse(response());
  terminal.drag({ target: document.querySelector('[data-cell="42"]') });
  assert.equal(terminal.selection.size, 0);
  terminal.pointerStart = 21;
  terminal.drag({ target: document.querySelector('[data-cell="21"]') });
  assert.equal(terminal.pointerMoved, false);
  terminal.drag({ target: document.querySelector('[data-cell="42"]') });
  assert.deepEqual([...terminal.selection], [21, 22, 41, 42]);
  terminal.pointerStart = 42;
  terminal.drag({ target: document.querySelector('[data-cell="21"]') });
  assert.deepEqual([...terminal.selection], [21, 22, 41, 42]);
  document.getElementById('number-grid').getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
  });
  terminal.pointerStart = 21;
  terminal.drag({ target: document.body, clientX: 25, clientY: 25 });
  assert.deepEqual([...terminal.selection], [21, 22, 41, 42]);
  terminal.drag({ target: document.body, clientX: 205, clientY: 25 });
  assert.equal(terminal.selection.size, 4);
});

test('Pointer dragging suppresses the synthetic click and cancellation clears dragging state', async (t) => {
  const { terminal, document, window, clock } = setup(t);
  await terminal.init();
  const start = document.querySelector('[data-cell="21"]');
  const end = document.querySelector('[data-cell="42"]');
  start.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  end.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  end.click();
  assert.equal(terminal.selection.size, 4);
  assert.equal(terminal.pointerStart, null);
  clock.value += 101;
  end.click();
  assert.equal(terminal.selection.size, 0);
  start.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  window.dispatchEvent(new window.Event('pointercancel'));
  assert.equal(terminal.pointerStart, null);
  start.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 2 }));
  assert.equal(terminal.pointerStart, null);
});

test('RefinementTerminal.keydown supports roving grid navigation, Space, Enter and bin shortcuts', async (t) => {
  const { terminal, document, window, calls } = setup(t);
  await terminal.init();
  document.querySelector('[data-cell="21"]').focus();
  for (const [key, expected] of [
    ['ArrowRight', '22'],
    ['ArrowDown', '42'],
    ['ArrowLeft', '41'],
    ['ArrowUp', '21'],
    ['Home', '20'],
    ['End', '39'],
  ]) {
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    assert.equal(document.activeElement.dataset.cell, expected);
  }
  document.querySelector('[data-cell="21"]').focus();
  document.activeElement.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }),
  );
  assert.equal(terminal.selection.size, 4);
  document.activeElement.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  assert.equal(terminal.selection.size, 0);
  terminal.selectCell(21);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['refine', 'signed-file-token', [21, 22, 41, 42], 1]);
});

test('RefinementTerminal.keydown respects row boundaries, editable fields, modifiers and open dialogs', async (t) => {
  const { terminal, document, window, calls } = setup(t);
  await terminal.init();
  const key = (value, target = document.activeElement, extra = {}) =>
    target.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: value, bubbles: true, ...extra }),
    );
  document.querySelector('[data-cell="0"]').focus();
  key('ArrowLeft');
  key('ArrowUp');
  assert.equal(document.activeElement.dataset.cell, '0');
  document.querySelector('[data-cell="199"]').focus();
  key('ArrowRight');
  key('ArrowDown');
  assert.equal(document.activeElement.dataset.cell, '199');
  key('a');
  terminal.selectCell(21);
  key('1', document, { ctrlKey: true });
  assert.equal(calls.length, 1);
  key('Escape', document);
  assert.equal(terminal.selection.size, 0);
  terminal.showNewFile();
  key('1', document.getElementById('assignment-file'));
  assert.equal(calls.length, 1);
  key('Escape', document);
  assert.equal(document.getElementById('modal').open, false);
  const input = document.createElement('input');
  document.body.append(input);
  terminal.selectCell(21);
  key('1', input);
  assert.equal(calls.length, 1);
});

test('RefinementTerminal.submit validates local prerequisites and sends sorted numbers', async (t) => {
  const { terminal, calls, sound } = setup(t);
  assert.equal(await terminal.submit(1), false);
  terminal.applyResponse(response());
  assert.equal(await terminal.submit(1), false);
  terminal.setSelection([42, 22, 41, 21]);
  for (const invalid of [0, 6, 1.5, '1']) assert.equal(await terminal.submit(invalid), false);
  assert.equal(await terminal.submit(1), true);
  assert.deepEqual(calls[0], ['refine', 'signed-file-token', [21, 22, 41, 42], 1]);
  assert.equal(terminal.selection.size, 0);
  assert.ok(sound.played.includes('accepted'));
});

test('RefinementTerminal.scan reveals the next active group without selecting or charging points', (t) => {
  const { terminal, document, clock, sound } = setup(t);
  terminal.scan();
  terminal.applyResponse(response());
  terminal.state.board.clusters[0].collected = true;
  terminal.scan();
  assert.deepEqual([...terminal.scanned], [26, 27, 46, 47]);
  assert.equal(terminal.selection.size, 0);
  assert.equal(terminal.state.score, 0);
  assert.equal(terminal.scanUntil, clock.value + 15000);
  assert.equal(document.getElementById('scan-button').disabled, true);
  terminal.scan();
  assert.equal(sound.played.filter((kind) => kind === 'scan').length, 1);
  clock.value += 15000;
  terminal.tick();
  assert.equal(document.getElementById('scan-button').disabled, false);
  assert.equal(document.getElementById('scan-button').textContent, 'SCAN');
  for (const cluster of terminal.state.board.clusters) cluster.collected = true;
  terminal.scan();
  assert.equal(sound.played.filter((kind) => kind === 'scan').length, 1);
});

test('RefinementTerminal.tick derives elapsed time from server state and pauses closed files', (t) => {
  const { terminal, document, clock } = setup(t);
  terminal.tick();
  terminal.applyResponse(response({ elapsed_seconds: 65 }));
  clock.value += 5000;
  terminal.tick();
  assert.equal(document.getElementById('shift-clock').textContent, '01:10');
  assert.match(document.getElementById('shift-clock').getAttribute('aria-label'), /Time elapsed/);
  terminal.applyResponse(response({ status: 'completed', elapsed_seconds: 80 }));
  clock.value += 60000;
  terminal.tick();
  assert.equal(document.getElementById('shift-clock').textContent, '01:20');
});

test('RefinementTerminal.tick counts down overtime and asks the server to resolve expiry', async (t) => {
  const { terminal, document, clock, calls } = setup(t, {
    api: {
      restore: async () => {
        calls.push(['expired']);
        return response({ status: 'failed', mode: 'overtime', remaining_seconds: 0 });
      },
    },
  });
  terminal.applyResponse(response({ mode: 'overtime', remaining_seconds: 3 }));
  assert.equal(document.getElementById('shift-clock').textContent, '00:03');
  assert.equal(document.getElementById('shift-clock').classList.contains('is-urgent'), true);
  clock.value += 3000;
  terminal.tick();
  assert.equal(terminal.pending, true);
  terminal.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(terminal.state.status, 'failed');
  assert.equal(document.getElementById('shift-clock').textContent, '00:00');
});

test('RefinementTerminal.notify updates the live region and removes the toast after its duration', (t) => {
  const { terminal, document, window } = setup(t);
  let callback;
  let delay;
  const original = window.setTimeout;
  window.setTimeout = (fn, ms) => {
    callback = fn;
    delay = ms;
    return 7;
  };
  terminal.notify('Keep refining.');
  assert.equal(document.getElementById('announcement').textContent, 'Keep refining.');
  assert.equal(document.getElementById('toast').classList.contains('is-visible'), true);
  assert.equal(document.getElementById('toast').hidden, false);
  assert.equal(delay, 5500);
  callback();
  assert.equal(document.getElementById('toast').classList.contains('is-visible'), false);
  assert.equal(document.getElementById('toast').hidden, true);
  window.setTimeout = original;
});

test('RefinementTerminal.applyPreferences saves settings and respects system reduced motion', (t) => {
  const { terminal, document, window, sound, store } = setup(t);
  window.matchMedia = () => ({ matches: true });
  terminal.applyPreferences();
  assert.equal(document.body.classList.contains('reduced-motion'), true);
  assert.equal(sound.enabled, false);
  assert.equal(document.getElementById('sound-button').getAttribute('aria-pressed'), 'false');
  window.matchMedia = () => ({ matches: false });
  terminal.preferences = { sound: true, reducedMotion: true };
  terminal.applyPreferences();
  assert.equal(sound.enabled, true);
  assert.equal(document.getElementById('sound-button').textContent, 'SOUND ON');
  assert.deepEqual(store.preferences(), terminal.preferences);
});

test('RefinementTerminal.toggleSound changes the saved setting and plays a confirmation tone', (t) => {
  const { terminal, sound, store } = setup(t);
  terminal.toggleSound();
  assert.equal(store.preferences().sound, true);
  assert.equal(sound.enabled, true);
  assert.equal(sound.played.at(-1), 'select');
  terminal.toggleSound();
  assert.equal(store.preferences().sound, false);
});

test('RefinementTerminal.openModal renders trusted copy, DOM content and action buttons', (t) => {
  const { terminal, document } = setup(t);
  let activated = false;
  terminal.openModal('Test title', '<p>Trusted content</p>', [
    {
      label: 'Continue',
      primary: true,
      run: () => {
        activated = true;
      },
    },
  ]);
  assert.equal(document.getElementById('modal').open, true);
  assert.equal(document.getElementById('modal-title').textContent, 'Test title');
  assert.equal(document.querySelector('#modal-content p').textContent, 'Trusted content');
  document.querySelector('#modal-actions .button-primary').click();
  assert.equal(activated, true);
  const content = document.createElement('p');
  content.textContent = '<script>not markup</script>';
  terminal.openModal('DOM content', content);
  assert.equal(document.getElementById('modal-content').textContent, '<script>not markup</script>');
  assert.equal(document.querySelector('#modal-content script'), null);
  assert.equal(document.getElementById('modal-actions').children.length, 0);
});

test('RefinementTerminal.closeModal restores the original keyboard focus including native dialog APIs', (t) => {
  const { terminal, document } = setup(t);
  const trigger = document.getElementById('help-button');
  trigger.focus();
  const modal = document.getElementById('modal');
  let opened = 0;
  let closed = 0;
  modal.showModal = () => {
    opened += 1;
    modal.setAttribute('open', '');
  };
  modal.close = () => {
    closed += 1;
    modal.removeAttribute('open');
  };
  terminal.openModal('First', '<p>Copy</p>');
  terminal.openModal('Replacement', '<p>Copy</p>');
  terminal.closeModal();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(modal.open, false);
  assert.equal(document.activeElement, trigger);
});

test('RefinementTerminal.showHelp explains completion, assisted selection, keyboard controls and modes', (t) => {
  const { terminal, document } = setup(t);
  terminal.showHelp();
  const copy = document.getElementById('modal-content').textContent;
  for (const expected of [
    'four sections',
    'group of four',
    'arrow keys',
    '1–5',
    'Orientation',
    '15 minutes',
    '8 minutes',
    'eighth mistake',
  ])
    assert.ok(copy.includes(expected));
  document.querySelector('#modal-actions button').click();
  assert.equal(document.getElementById('modal').open, false);
});

test('RefinementTerminal.showNewFile requires an explicit replacement action and honors file and mode choices', async (t) => {
  const { terminal, document, calls } = setup(t);
  terminal.applyResponse(response());
  terminal.showNewFile();
  assert.match(document.getElementById('modal-content').textContent, /progress will be lost/);
  assert.equal(calls.length, 0);
  document.querySelector('#modal-actions button').click();
  assert.equal(calls.length, 0);
  terminal.showNewFile();
  document.getElementById('assignment-file').value = 'Siena';
  document.getElementById('assignment-mode').value = 'orientation';
  document.querySelector('#modal-actions .button-primary').click();
  assert.equal(terminal.pending, true);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[0], ['create', 'orientation', 'Siena']);
  assert.equal(document.getElementById('modal').open, false);
  terminal.pending = true;
  terminal.showNewFile();
  assert.equal(document.getElementById('modal').open, false);
});

test('RefinementTerminal.showNewFile keeps the confirmation open and saved file intact if creation fails', async (t) => {
  const { terminal, document, store } = setup(t, {
    api: {
      create: async () => {
        throw new Error('offline');
      },
    },
  });
  terminal.applyResponse(response());
  terminal.showNewFile();
  document.querySelector('#modal-actions .button-primary').click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(document.getElementById('modal').open, true);
  assert.equal(store.token(), 'signed-file-token');
});

test('RefinementTerminal.showSettings saves sound and animation choices', (t) => {
  const { terminal, document, store } = setup(t);
  terminal.showSettings();
  assert.equal(document.getElementById('preference-sound').checked, false);
  document.getElementById('preference-sound').checked = true;
  document.getElementById('preference-motion').checked = true;
  document.querySelector('#modal-actions button').click();
  assert.deepEqual(store.preferences(), { sound: true, reducedMotion: true });
  assert.equal(document.body.classList.contains('reduced-motion'), true);
  assert.equal(document.getElementById('modal').open, false);
  terminal.showSettings();
  assert.equal(document.getElementById('preference-sound').checked, true);
  assert.equal(document.getElementById('preference-motion').checked, true);
});

test('RefinementTerminal.showArchive renders empty and populated history safely as text', (t) => {
  const { terminal, document, store } = setup(t);
  terminal.showArchive();
  assert.ok(document.querySelector('.archive-empty'));
  store.archive(
    response({ id: 'safe', status: 'completed', file: '<img src=x onerror=alert(1)>', score: 1800 })
      .state,
  );
  store.archive(response({ id: 'failed', status: 'failed', file: 'Siena' }).state);
  terminal.showArchive();
  assert.equal(document.querySelectorAll('.archive-row').length, 2);
  assert.equal(document.querySelector('#modal-content img'), null);
  assert.match(document.getElementById('modal-content').textContent, /REFINED/);
  assert.match(document.getElementById('modal-content').textContent, /CLOSED/);
  document.querySelector('#modal-actions button').click();
  assert.equal(document.getElementById('modal').open, false);
});

test('RefinementTerminal.showResult presents rewards, final statistics and a next-file path', (t) => {
  const { terminal, document, sound } = setup(t);
  terminal.applyResponse(
    response({ status: 'completed', score: 2400, elapsed_seconds: 135, progress: 100 }),
  );
  assert.equal(document.querySelector('.result-badge').textContent, '100% REFINED');
  assert.match(document.getElementById('modal-content').textContent, /waffle party/);
  assert.match(document.querySelector('.dialog-stat').textContent, /2400 POINTS.*2m 15s/);
  assert.ok(sound.played.includes('complete'));
  document.querySelector('#modal-actions button').click();
  assert.equal(document.getElementById('modal').open, false);
  terminal.showResult();
  document.querySelector('#modal-actions .button-primary').click();
  assert.equal(document.getElementById('modal-title').textContent, 'Your next assignment');
  terminal.applyResponse(response({ id: 'failed-file', status: 'failed', mistakes: 5 }));
  assert.equal(document.querySelector('.result-badge').textContent, 'ASSIGNMENT CLOSED');
  assert.match(document.getElementById('modal-content').textContent, /Orientation mode/);
});

test('SoundEngine.play and dispose safely settle rejected browser audio promises', async () => {
  const engine = new SoundEngine({ AudioContext: class {} });
  let played = false;
  engine.setEnabled(true);
  engine.context = {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    resume: () => Promise.reject(new Error('audio permission denied')),
    createOscillator: () => ({
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {
        played = true;
      },
      stop() {},
    }),
    createGain: () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    }),
    close: () => Promise.reject(new Error('already closed')),
  };
  assert.doesNotThrow(() => engine.play());
  assert.doesNotThrow(() => engine.dispose());
  await Promise.resolve();
  assert.equal(played, true);
  assert.equal(engine.context, null);
});

test('RefinementTerminal.init connects bin clicks, periodic clock updates and reconnect actions', async (t) => {
  const { terminal, document, window, clock, calls } = setup(t);
  let interval;
  window.setInterval = (callback) => {
    interval = callback;
    return 1;
  };
  await terminal.init();
  clock.value += 2000;
  interval();
  assert.equal(document.getElementById('shift-clock').textContent, '00:02');
  terminal.selectCell(21);
  document.getElementById('bin-1').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['refine', 'signed-file-token', [21, 22, 41, 42], 1]);
  terminal.lastError = new Error('offline');
  terminal.renderControls();
  const retry = document.getElementById('retry-button');
  assert.equal(retry.hidden, false);
  retry.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['restore', 'signed-file-token']);
  assert.equal(retry.hidden, true);
  terminal.token = null;
  terminal.lastError = new Error('initial connection failed');
  terminal.renderControls();
  retry.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['create', 'standard', 'Cold Harbor']);
});

test('RefinementTerminal.tick backs off deadline checks after a network interruption', async (t) => {
  let attempts = 0;
  const { terminal, clock } = setup(t, {
    api: {
      restore: async () => {
        attempts += 1;
        throw new Error('offline');
      },
    },
  });
  terminal.applyResponse(response({ remaining_seconds: 1 }));
  clock.value += 1000;
  terminal.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1);
  clock.value += 1000;
  terminal.tick();
  assert.equal(attempts, 1);
  clock.value += 14000;
  terminal.tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(terminal.token, 'signed-file-token');
});
