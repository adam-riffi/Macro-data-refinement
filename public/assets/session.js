/** Transport, browser persistence and optional sound for the v2 terminal. */
export class RefinementApi {
  constructor(fetcher = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
  }

  async request(path, payload) {
    let response;
    try {
      response = await this.fetcher(`/api/v2/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error('Terminal connection interrupted. Your saved file is safe. Try again.');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      const error = new Error('The terminal received an unreadable response. Please try again.');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(
        typeof data?.detail === 'string'
          ? data.detail
          : typeof data?.error === 'string'
            ? data.error
            : 'The request could not be completed.',
      );
      error.status = response.status;
      throw error;
    }
    const state = data?.state;
    if (
      typeof data?.token !== 'string' ||
      !data.token.trim() ||
      !state ||
      Array.isArray(state) ||
      typeof state.id !== 'string' ||
      !state.id ||
      !['quota', 'timed', 'endless'].includes(state.mode) ||
      !['normal', 'quota_achiever', 'quarter_refiner'].includes(state.difficulty) ||
      !['active', 'completed', 'failed'].includes(state.status) ||
      !Number.isFinite(state.score) ||
      !Array.isArray(state.bins) ||
      !state.world ||
      typeof state.world !== 'object' ||
      Array.isArray(state.world)
    ) {
      const error = new Error('The terminal received an incomplete file. Please try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  create(mode = 'quota', difficulty = 'normal', file = 'Cold Harbor') {
    return this.request('session', { mode, difficulty, file });
  }

  restore(token) {
    return this.request('restore', { token });
  }

  capture(token, clusterId) {
    return this.request('capture', { token, cluster_id: clusterId });
  }

  mistake(token, cell) {
    return this.request('mistake', { token, cell });
  }
}

export class LocalSessionStore {
  constructor(storage) {
    this.storage = storage;
    this.memory = new Map();
    this.preserveLegacy();
  }

  get(key, fallback) {
    // A failed persistent write must never resurrect an older saved assignment.
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const stored = this.storage?.getItem(`mdr.v2.${key}`);
      return stored === null || stored === undefined ? fallback : JSON.parse(stored);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    this.memory.set(key, value);
    try {
      this.storage?.setItem(`mdr.v2.${key}`, JSON.stringify(value));
    } catch {
      // Private browsing and full storage still permit the current in-memory shift.
    }
  }

  token() {
    const token = this.get('session', null);
    return typeof token === 'string' && token.trim() ? token : null;
  }

  saveToken(token) {
    this.set('session', typeof token === 'string' && token.trim() ? token : null);
  }

  preferences() {
    const value = this.get('preferences', null);
    return { sound: value?.sound === true, reducedMotion: value?.reducedMotion === true };
  }

  savePreferences(preferences) {
    this.set('preferences', {
      sound: preferences?.sound === true,
      reducedMotion: preferences?.reducedMotion === true,
    });
  }

  sanitizeView(value) {
    if (!value || typeof value !== 'object' || !value.camera) return null;
    const { x, y, zoom } = value.camera;
    if (![x, y, zoom].every(Number.isFinite)) return null;
    const replacements = new Map();
    if (Array.isArray(value.replacements)) {
      for (const entry of value.replacements.slice(0, 40960)) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          Number.isInteger(entry[0]) &&
          entry[0] >= 0 &&
          entry[0] < 40960 &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 0 &&
          entry[1] <= 9
        )
          replacements.set(entry[0], entry[1]);
      }
    }
    return {
      camera: {
        x: Math.max(0, Math.min(9216, x)),
        y: Math.max(0, Math.min(6720, y)),
        zoom: Math.max(0.5, Math.min(3, zoom)),
      },
      replacements: [...replacements],
    };
  }

  view(id) {
    const value = this.get('view', null);
    return value?.id === id ? this.sanitizeView(value) : null;
  }

  saveView(id, value) {
    if (typeof id !== 'string' || !id) return;
    const clean = this.sanitizeView(value);
    if (clean) this.set('view', { id, ...clean });
  }

  history() {
    const value = this.get('history', []);
    if (!Array.isArray(value)) return [];
    const history = [];
    const seen = new Set();
    for (const entry of value) {
      if (entry && typeof entry.id === 'string' && entry.id && !seen.has(entry.id)) {
        history.push(entry);
        seen.add(entry.id);
        if (history.length === 30) break;
      }
    }
    return history;
  }

  archive(state) {
    if (
      !state ||
      !['completed', 'failed'].includes(state.status) ||
      typeof state.id !== 'string' ||
      !state.id
    )
      return;
    const history = this.history();
    if (history.some((entry) => entry.id === state.id)) return;
    this.set(
      'history',
      [
        {
          id: state.id,
          file: state.file,
          mode: state.mode,
          difficulty: state.difficulty,
          status: state.status,
          score: state.score,
          elapsed_seconds: state.elapsed_seconds,
          completedAt: new Date().toISOString(),
        },
        ...history,
      ].slice(0, 30),
    );
  }

  preserveLegacy() {
    try {
      if (!this.storage || this.storage.getItem('mdr.legacy-session') !== null) return false;
      const legacy = this.storage.getItem('mdr.session');
      if (legacy === null) return false;
      this.storage.setItem('mdr.legacy-session', legacy);
      return true;
    } catch {
      // Leave all original legacy keys intact, even if a backup cannot be written.
      return false;
    }
  }
}

export class TerminalAudio {
  constructor(window = globalThis) {
    this.window = window;
    this.enabled = false;
    this.context = null;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  play(kind = 'select') {
    if (!this.enabled) return;
    try {
      const AudioContext = this.window.AudioContext || this.window.webkitAudioContext;
      if (!AudioContext) return;
      this.context ||= new AudioContext();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const frequency = { select: 340, capture: 720, reject: 115, complete: 940 }[kind] || 340;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, this.context.currentTime);
      gain.gain.setValueAtTime(0.045, this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.17);
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      oscillator.start();
      oscillator.stop(this.context.currentTime + 0.18);
    } catch {
      // Browser audio restrictions must never interrupt refinement.
    }
  }

  dispose() {
    try {
      this.context?.close()?.catch(() => {});
    } catch {
      // A context may already have been closed by the browser.
    }
    this.context = null;
  }
}
