import test from 'node:test';
import assert from 'node:assert/strict';
import { RefinementApi, LocalSessionStore, TerminalAudio } from '../../public/assets/session.js';

function envelope(overrides = {}) {
  return {
    token: 'signed-v2-token',
    state: {
      id: 'assignment-1',
      file: 'Cold Harbor',
      mode: 'quota',
      difficulty: 'normal',
      status: 'active',
      score: 0,
      bins: [],
      world: { columns: 256, rows: 160, clusters: [] },
      ...overrides,
    },
  };
}

function transport(data = envelope(), status = 200) {
  const calls = [];
  const api = new RefinementApi(async (...args) => {
    calls.push(args);
    return { ok: status < 400, status, json: async () => data };
  });
  return { api, calls };
}

function storageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function audioFixture({ state = 'running', rejectResume = false, rejectClose = false } = {}) {
  const events = [];
  class AudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 7;
      this.destination = 'speakers';
      events.push(['context']);
    }
    resume() {
      events.push(['resume']);
      return rejectResume ? Promise.reject(new Error('blocked')) : Promise.resolve();
    }
    createOscillator() {
      const oscillator = {
        frequency: { setValueAtTime: (...args) => events.push(['frequency', ...args]) },
        connect: (gain) => events.push(['oscillator-connect', gain]),
        start: () => events.push(['start', oscillator.type]),
        stop: (time) => events.push(['stop', time]),
      };
      return oscillator;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: (...args) => events.push(['volume', ...args]),
          exponentialRampToValueAtTime: (...args) => events.push(['fade', ...args]),
        },
        connect: (destination) => events.push(['gain-connect', destination]),
      };
    }
    close() {
      events.push(['close']);
      return rejectClose ? Promise.reject(new Error('closed')) : Promise.resolve();
    }
  }
  return { events, AudioContext };
}

test('RefinementApi.constructor uses injected or bound browser fetch', () => {
  const fetcher = () => {};
  assert.equal(new RefinementApi(fetcher).fetcher, fetcher);
  assert.equal(typeof new RefinementApi().fetcher, 'function');
});

test('RefinementApi.request posts v2 JSON with a 12 second abort deadline', async (t) => {
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const { api, calls } = transport();
  assert.deepEqual(await api.request('restore', { token: 'saved' }), envelope());
  assert.equal(timeout.mock.calls[0].arguments[0], 12000);
  assert.deepEqual(calls, [
    [
      '/api/v2/restore',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"token":"saved"}',
        cache: 'no-store',
        signal: controller.signal,
      },
    ],
  ]);
});

test('RefinementApi.request gives readable network and timeout failures without replacing saves', async () => {
  for (const reason of [new Error('offline'), new DOMException('Timeout', 'TimeoutError')]) {
    const api = new RefinementApi(async () => {
      throw reason;
    });
    await assert.rejects(api.restore('old-token'), /saved file is safe/);
  }
});

test('RefinementApi.request preserves HTTP status for server and unreadable responses', async () => {
  for (const [data, message] of [
    [{ detail: 'Token expired' }, 'Token expired'],
    [{ error: 'Invalid cluster' }, 'Invalid cluster'],
    [{ detail: {}, error: {} }, 'The request could not be completed.'],
    [null, 'The request could not be completed.'],
  ]) {
    await assert.rejects(transport(data, 422).api.restore('saved'), { message, status: 422 });
  }
  const api = new RefinementApi(async () => ({
    ok: false,
    status: 503,
    json: async () => {
      throw new Error('html gateway response');
    },
  }));
  await assert.rejects(api.restore('saved'), { status: 503, message: /unreadable response/ });
});

test('RefinementApi.request rejects malformed envelopes and invalid playable state', async () => {
  const invalid = [
    null,
    {},
    { token: 4, state: {} },
    { token: ' ', state: {} },
    { token: 'saved' },
    { token: 'saved', state: [] },
    envelope({ id: null }),
    envelope({ id: '' }),
    envelope({ mode: 'standard' }),
    envelope({ difficulty: 'unknown' }),
    envelope({ status: 'unknown' }),
    envelope({ score: NaN }),
    envelope({ bins: {} }),
    envelope({ world: null }),
    envelope({ world: 'digits' }),
    envelope({ world: [] }),
  ];
  for (const value of invalid)
    await assert.rejects(transport(value).api.restore('saved'), {
      message: /incomplete file/,
      status: 200,
    });
  for (const mode of ['quota', 'timed', 'endless'])
    for (const difficulty of ['normal', 'quota_achiever', 'quarter_refiner'])
      for (const status of ['active', 'completed', 'failed'])
        assert.equal(
          (await transport(envelope({ mode, difficulty, status })).api.restore('saved')).state
            .status,
          status,
        );
});

test('RefinementApi.create supplies defaults and passes independent mode and difficulty choices', async () => {
  const { api, calls } = transport();
  await api.create();
  await api.create('endless', 'quarter_refiner', 'Siena');
  assert.equal(calls[0][0], '/api/v2/session');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    mode: 'quota',
    difficulty: 'normal',
    file: 'Cold Harbor',
  });
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    mode: 'endless',
    difficulty: 'quarter_refiner',
    file: 'Siena',
  });
});

test('RefinementApi.restore posts the signed token without altering it', async () => {
  const { api, calls } = transport();
  await api.restore('saved-token');
  assert.equal(calls[0][0], '/api/v2/restore');
  assert.deepEqual(JSON.parse(calls[0][1].body), { token: 'saved-token' });
});

test('RefinementApi.capture posts the versioned cluster identifier', async () => {
  const { api, calls } = transport();
  await api.capture('saved', 'cluster-10-v2');
  assert.equal(calls[0][0], '/api/v2/capture');
  assert.deepEqual(JSON.parse(calls[0][1].body), { token: 'saved', cluster_id: 'cluster-10-v2' });
});

test('RefinementApi.mistake posts the ordinary number cell for authoritative penalty handling', async () => {
  const { api, calls } = transport();
  await api.mistake('saved', 40959);
  assert.equal(calls[0][0], '/api/v2/mistake');
  assert.deepEqual(JSON.parse(calls[0][1].body), { token: 'saved', cell: 40959 });
});

test('LocalSessionStore.constructor supports absent storage and preserves legacy data automatically', () => {
  const empty = new LocalSessionStore(null);
  assert.equal(empty.storage, null);
  assert.equal(empty.memory.size, 0);
  const storage = storageFixture({ 'mdr.session': 'raw-token' });
  assert.equal(new LocalSessionStore(storage).storage, storage);
  assert.equal(storage.getItem('mdr.legacy-session'), 'raw-token');
});

test('LocalSessionStore.get loads JSON and handles missing malformed or denied storage', () => {
  assert.equal(new LocalSessionStore().get('unknown', 4), 4);
  const storage = storageFixture({ 'mdr.v2.good': '{"value":7}', 'mdr.v2.bad': 'bad json' });
  const store = new LocalSessionStore(storage);
  assert.deepEqual(store.get('good', null), { value: 7 });
  assert.equal(store.get('bad', 4), 4);
  assert.equal(store.get('absent', 5), 5);
  const denied = new LocalSessionStore({
    getItem() {
      throw new Error('denied');
    },
  });
  assert.equal(denied.get('absent', 6), 6);
});

test('LocalSessionStore.set writes v2 JSON and latest memory wins over stale storage after failed writes', () => {
  const storage = storageFixture({ 'mdr.v2.session': '"old"' });
  const store = new LocalSessionStore(storage);
  store.set('preferences', { sound: true });
  assert.equal(storage.getItem('mdr.v2.preferences'), '{"sound":true}');
  storage.setItem = () => {
    throw new Error('quota exceeded');
  };
  store.set('session', 'new');
  assert.equal(store.get('session', null), 'new');
  assert.equal(storage.getItem('mdr.v2.session'), '"old"');
  store.set('session', null);
  assert.equal(store.get('session', 'fallback'), null);
  const absent = new LocalSessionStore(null);
  absent.set('value', false);
  assert.equal(absent.get('value', true), false);
});

test('LocalSessionStore.token accepts only nonempty string tokens', () => {
  const store = new LocalSessionStore(null);
  assert.equal(store.token(), null);
  for (const token of [2, {}, [], false, '', '   ']) {
    store.set('session', token);
    assert.equal(store.token(), null);
  }
  store.set('session', 'signed-token');
  assert.equal(store.token(), 'signed-token');
});

test('LocalSessionStore.saveToken persists a valid token and explicitly clears invalid tokens', () => {
  const store = new LocalSessionStore(null);
  store.saveToken('signed');
  assert.equal(store.token(), 'signed');
  for (const token of [null, '', ' ', {}]) {
    store.saveToken(token);
    assert.equal(store.get('session', 'missing'), null);
  }
});

test('LocalSessionStore.preferences normalizes stored flags and supplies quiet defaults', () => {
  const store = new LocalSessionStore(null);
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
  store.set('preferences', { sound: true, reducedMotion: true });
  assert.deepEqual(store.preferences(), { sound: true, reducedMotion: true });
  store.set('preferences', { sound: 'true', reducedMotion: 1 });
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
});

test('LocalSessionStore.savePreferences saves only boolean options without extra properties', () => {
  const store = new LocalSessionStore(null);
  store.savePreferences({ sound: true, reducedMotion: true, ignored: 'value' });
  assert.deepEqual(store.get('preferences'), { sound: true, reducedMotion: true });
  store.savePreferences(null);
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
  store.savePreferences({ sound: 1, reducedMotion: 'true' });
  assert.deepEqual(store.preferences(), { sound: false, reducedMotion: false });
});

test('LocalSessionStore.sanitizeView rejects unusable cameras and clamps world pixel coordinates', () => {
  const store = new LocalSessionStore(null);
  for (const value of [null, 'bad', {}, { camera: {} }, { camera: { x: 1, y: NaN, zoom: 1 } }])
    assert.equal(store.sanitizeView(value), null);
  assert.deepEqual(store.sanitizeView({ camera: { x: -20, y: 9000, zoom: 10 } }), {
    camera: { x: 0, y: 6720, zoom: 3 },
    replacements: [],
  });
  assert.deepEqual(store.sanitizeView({ camera: { x: 10000, y: -4, zoom: 0 } }), {
    camera: { x: 9216, y: 0, zoom: 0.5 },
    replacements: [],
  });
});

test('LocalSessionStore.sanitizeView validates replacement pairs and bounds saved payloads', () => {
  const store = new LocalSessionStore(null);
  const camera = { x: 100, y: 200, zoom: 1 };
  const replacements = [
    null,
    [],
    [1, 2, 3],
    ['1', 2],
    [-1, 2],
    [40960, 2],
    [3, '4'],
    [3, -1],
    [3, 10],
    [1.5, 2],
    [0, 0],
    [40959, 9],
    [0, 4],
  ];
  assert.deepEqual(store.sanitizeView({ camera, replacements }), {
    camera,
    replacements: [
      [0, 4],
      [40959, 9],
    ],
  });
  const large = Array.from({ length: 40961 }, (_, id) => [id, id % 10]);
  assert.equal(store.sanitizeView({ camera, replacements: large }).replacements.length, 40960);
  assert.deepEqual(
    store.sanitizeView({ camera, replacements: new Map([[1, 2]]) }).replacements,
    [],
  );
});

test('LocalSessionStore.view loads only the requested current file and rejects corrupt stored cameras', () => {
  const store = new LocalSessionStore(null);
  assert.equal(store.view('one'), null);
  store.set('view', { id: 'one', camera: { x: 5, y: 8, zoom: 1 }, replacements: [[1, 4]] });
  assert.deepEqual(store.view('one'), { camera: { x: 5, y: 8, zoom: 1 }, replacements: [[1, 4]] });
  assert.equal(store.view('two'), null);
  store.set('view', { id: 'one', camera: { x: 'bad', y: 0, zoom: 1 } });
  assert.equal(store.view('one'), null);
});

test('LocalSessionStore.saveView replaces a single current view without accumulating assignments', () => {
  const storage = storageFixture();
  const store = new LocalSessionStore(storage);
  const view = { camera: { x: 120, y: 280, zoom: 2 }, replacements: [[3, 5]], extra: 'discard' };
  store.saveView('one', view);
  assert.deepEqual(store.view('one'), { camera: view.camera, replacements: [[3, 5]] });
  store.saveView('two', view);
  assert.equal(store.view('one'), null);
  assert.equal(storage.values.size, 1);
  assert.equal(store.memory.size, 1);
  for (const id of [null, '', 1]) store.saveView(id, view);
  store.saveView('invalid-camera', {});
  assert.ok(store.view('two'));
});

test('LocalSessionStore.history filters invalid records and duplicate identifiers with a 30 file limit', () => {
  const store = new LocalSessionStore(null);
  assert.deepEqual(store.history(), []);
  store.set('history', {});
  assert.deepEqual(store.history(), []);
  store.set('history', [
    null,
    {},
    { id: 1 },
    { id: '' },
    { id: 'one' },
    { id: 'one' },
    { id: 'two' },
  ]);
  assert.deepEqual(store.history(), [{ id: 'one' }, { id: 'two' }]);
  store.set(
    'history',
    Array.from({ length: 35 }, (_, id) => ({ id: String(id) })),
  );
  assert.equal(store.history().length, 30);
});

test('LocalSessionStore.archive saves completed and failed assignments once in newest first order', () => {
  const store = new LocalSessionStore(null);
  for (const state of [
    null,
    {},
    envelope().state,
    { status: 'failed', id: 1 },
    { status: 'failed', id: '' },
  ])
    store.archive(state);
  assert.deepEqual(store.history(), []);
  const first = envelope({ status: 'completed', score: 54, elapsed_seconds: 33 }).state;
  store.archive(first);
  store.archive(first);
  assert.equal(store.history().length, 1);
  const entry = store.history()[0];
  const { completedAt, ...saved } = entry;
  assert.ok(Number.isFinite(Date.parse(completedAt)));
  assert.deepEqual(saved, {
    id: 'assignment-1',
    file: 'Cold Harbor',
    mode: 'quota',
    difficulty: 'normal',
    status: 'completed',
    score: 54,
    elapsed_seconds: 33,
  });
  for (let id = 2; id <= 32; id += 1) store.archive({ ...first, id: String(id), status: 'failed' });
  assert.equal(store.history().length, 30);
  assert.equal(store.history()[0].id, '32');
  assert.equal(store.history()[29].id, '3');
});

test('LocalSessionStore.preserveLegacy copies the exact legacy token once without deleting old history', () => {
  const storage = storageFixture();
  const store = new LocalSessionStore(storage);
  assert.equal(store.preserveLegacy(), false);
  storage.setItem('mdr.session', '"old.signed.token"');
  storage.setItem('mdr.history', '[{"id":"old"}]');
  assert.equal(store.preserveLegacy(), true);
  storage.setItem('mdr.session', '"later.old.token"');
  assert.equal(store.preserveLegacy(), false);
  assert.equal(storage.getItem('mdr.legacy-session'), '"old.signed.token"');
  assert.equal(storage.getItem('mdr.session'), '"later.old.token"');
  assert.equal(storage.getItem('mdr.history'), '[{"id":"old"}]');
  assert.equal(new LocalSessionStore(null).preserveLegacy(), false);
  const failing = storageFixture({ 'mdr.session': 'unmodified' });
  failing.setItem = () => {
    throw new Error('full');
  };
  assert.equal(new LocalSessionStore(failing).preserveLegacy(), false);
  assert.equal(failing.getItem('mdr.session'), 'unmodified');
});

test('TerminalAudio.constructor creates no audio context and supports default or injected window', () => {
  const window = {};
  const audio = new TerminalAudio(window);
  assert.equal(audio.window, window);
  assert.equal(audio.enabled, false);
  assert.equal(audio.context, null);
  assert.equal(new TerminalAudio().window, globalThis);
});

test('TerminalAudio.setEnabled normalizes explicit sound preferences', () => {
  const audio = new TerminalAudio({});
  audio.setEnabled(1);
  assert.equal(audio.enabled, true);
  audio.setEnabled(false);
  assert.equal(audio.enabled, false);
});

test('TerminalAudio.play creates quiet short tones and reuses the audio context', () => {
  const fixture = audioFixture();
  const audio = new TerminalAudio(fixture);
  audio.play();
  assert.deepEqual(fixture.events, []);
  audio.setEnabled(true);
  audio.play();
  for (const kind of ['capture', 'reject', 'complete', 'unknown']) audio.play(kind);
  assert.deepEqual(
    fixture.events.filter(([event]) => event === 'frequency').map((event) => event[1]),
    [340, 720, 115, 940, 340],
  );
  assert.equal(fixture.events.filter(([event]) => event === 'context').length, 1);
  assert.ok(fixture.events.some((event) => event[0] === 'volume' && event[1] === 0.045));
  assert.ok(
    fixture.events.some((event) => event[0] === 'fade' && event[1] === 0.001 && event[2] === 7.17),
  );
  assert.ok(fixture.events.some((event) => event[0] === 'stop' && event[1] === 7.18));
  assert.ok(fixture.events.some((event) => event[0] === 'start' && event[1] === 'sine'));
  assert.ok(fixture.events.some((event) => event[0] === 'gain-connect' && event[1] === 'speakers'));
});

test('TerminalAudio.play tolerates unsupported and restricted browsers and resumes suspended contexts', async () => {
  const unsupported = new TerminalAudio({});
  unsupported.setEnabled(true);
  assert.doesNotThrow(() => unsupported.play());
  const blocked = new TerminalAudio({
    AudioContext: class {
      constructor() {
        throw new Error('blocked');
      }
    },
  });
  blocked.setEnabled(true);
  assert.doesNotThrow(() => blocked.play());
  for (const rejectResume of [false, true]) {
    const fixture = audioFixture({ state: 'suspended', rejectResume });
    const audio = new TerminalAudio({ webkitAudioContext: fixture.AudioContext });
    audio.setEnabled(true);
    audio.play();
    await Promise.resolve();
    assert.ok(fixture.events.some(([event]) => event === 'resume'));
  }
});

test('TerminalAudio.dispose closes contexts and tolerates empty synchronously or asynchronously closed contexts', async () => {
  const audio = new TerminalAudio({});
  audio.dispose();
  assert.equal(audio.context, null);
  for (const rejectClose of [false, true]) {
    const fixture = audioFixture({ rejectClose });
    audio.context = new fixture.AudioContext();
    audio.dispose();
    await Promise.resolve();
    assert.equal(audio.context, null);
    assert.ok(fixture.events.some(([event]) => event === 'close'));
  }
  audio.context = { close: () => undefined };
  audio.dispose();
  audio.context = {
    close: () => {
      throw new Error('already closed');
    },
  };
  assert.doesNotThrow(() => audio.dispose());
  assert.equal(audio.context, null);
});
