/** Browser components for the Macrodata Refinement terminal. No import side effects. */
export class ApiClient {
  constructor(fetcher = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
  }

  async request(path, payload) {
    let response;
    try {
      response = await this.fetcher(`/api/${path}`, {
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
      throw new Error('The terminal received an unreadable response. Please try again.');
    }
    if (!response.ok) {
      const error = new Error(
        typeof data.detail === 'string'
          ? data.detail
          : data.error || 'The request could not be completed.',
      );
      error.status = response.status;
      throw error;
    }
    if (!data.state || typeof data.token !== 'string') {
      throw new Error('The terminal received an incomplete file. Please try again.');
    }
    return data;
  }

  create(mode = 'standard', file = 'Cold Harbor') {
    return this.request('session', { mode, file });
  }

  restore(token) {
    return this.request('restore', { token });
  }

  refine(token, cells, bin) {
    return this.request('refine', { token, cells, bin });
  }
}

export class SessionStore {
  constructor(storage) {
    this.storage = storage;
    this.memory = new Map();
  }

  get(key, fallback) {
    try {
      const stored = this.storage?.getItem(`mdr.${key}`);
      return stored === null || stored === undefined
        ? (this.memory.get(key) ?? fallback)
        : JSON.parse(stored);
    } catch {
      return this.memory.get(key) ?? fallback;
    }
  }

  set(key, value) {
    this.memory.set(key, value);
    try {
      this.storage?.setItem(`mdr.${key}`, JSON.stringify(value));
    } catch {
      // Storage may be unavailable in private windows; the current shift still works.
    }
  }

  token() {
    const token = this.get('session', null);
    return typeof token === 'string' ? token : null;
  }

  saveToken(token) {
    this.set('session', token);
  }

  preferences() {
    const value = this.get('preferences', {});
    return { sound: value?.sound === true, reducedMotion: value?.reducedMotion === true };
  }

  savePreferences(preferences) {
    this.set('preferences', {
      sound: !!preferences.sound,
      reducedMotion: !!preferences.reducedMotion,
    });
  }

  history() {
    const value = this.get('history', []);
    return Array.isArray(value)
      ? value.filter((entry) => entry && typeof entry.id === 'string')
      : [];
  }

  archive(state) {
    if (state.status === 'active') return;
    const history = this.history();
    if (history.some((entry) => entry.id === state.id)) return;
    this.set(
      'history',
      [
        {
          id: state.id,
          file: state.file,
          mode: state.mode,
          status: state.status,
          score: state.score,
          elapsed_seconds: state.elapsed_seconds,
          completedAt: new Date().toISOString(),
        },
        ...history,
      ].slice(0, 30),
    );
  }
}

export class SoundEngine {
  constructor(window) {
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
      const frequency =
        { select: 340, accepted: 720, rejected: 115, scan: 520, complete: 940 }[kind] || 340;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, this.context.currentTime);
      gain.gain.setValueAtTime(0.045, this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.17);
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      oscillator.start();
      oscillator.stop(this.context.currentTime + 0.18);
    } catch {
      // A browser audio restriction must never interrupt refinement.
    }
  }

  dispose() {
    try {
      this.context?.close()?.catch(() => {});
    } catch {
      /* Already closed. */
    }
    this.context = null;
  }
}

export class RefinementTerminal {
  constructor(document, window, options = {}) {
    this.document = document;
    this.window = window;
    this.api = options.api || new ApiClient(window.fetch.bind(window));
    let storage;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    this.store = options.store || new SessionStore(storage);
    this.sound = options.sound || new SoundEngine(window);
    this.now = options.now || Date.now;
    this.state = null;
    this.token = this.store.token();
    this.selection = new Set();
    this.pending = false;
    this.lastError = null;
    this.scanUntil = 0;
    this.restoreAfter = 0;
    this.scanned = new Set();
    this.hovered = new Set();
    this.pointerStart = null;
    this.pointerMoved = false;
    this.suppressClickUntil = 0;
    this.receivedAt = this.now();
    this.resultShown = null;
    this.listeners = new window.AbortController();
    this.preferences = this.store.preferences();
  }

  element(id) {
    return this.document.getElementById(id);
  }

  async init() {
    const signal = this.listeners.signal;
    const grid = this.element('number-grid');
    this.applyPreferences();
    grid.addEventListener(
      'click',
      (event) => {
        const cell = event.target.closest('[data-cell]');
        if (cell && this.now() >= this.suppressClickUntil)
          this.selectCell(Number(cell.dataset.cell));
      },
      { signal },
    );
    grid.addEventListener(
      'pointerdown',
      (event) => {
        const cell = event.target.closest('[data-cell]');
        if (
          !cell ||
          this.pending ||
          this.state?.status !== 'active' ||
          (event.button !== undefined && event.button !== 0)
        )
          return;
        this.pointerStart = Number(cell.dataset.cell);
        this.pointerMoved = false;
        cell.focus({ preventScroll: true });
      },
      { signal },
    );
    this.window.addEventListener('pointermove', (event) => this.drag(event), { signal });
    this.window.addEventListener(
      'pointerup',
      () => {
        if (this.pointerMoved) this.suppressClickUntil = this.now() + 100;
        this.pointerStart = null;
        this.pointerMoved = false;
      },
      { signal },
    );
    this.window.addEventListener(
      'pointercancel',
      () => {
        this.pointerStart = null;
        this.pointerMoved = false;
      },
      { signal },
    );
    grid.addEventListener(
      'pointerover',
      (event) => {
        const cell = event.target.closest('[data-cell]');
        this.hover(cell ? Number(cell.dataset.cell) : null);
      },
      { signal },
    );
    grid.addEventListener('pointerleave', () => this.hover(null), { signal });
    grid.addEventListener(
      'focusin',
      (event) => {
        const cell = event.target.closest('[data-cell]');
        if (!cell) return;
        for (const button of grid.querySelectorAll('[data-cell]'))
          button.tabIndex = button === cell ? 0 : -1;
        this.element('coordinates').textContent = this.coordinates(Number(cell.dataset.cell));
      },
      { signal },
    );
    this.document.addEventListener('keydown', (event) => this.keydown(event), { signal });
    for (let bin = 1; bin <= 5; bin += 1) {
      this.element(`bin-${bin}`).addEventListener('click', () => this.submit(bin), { signal });
    }
    for (const [id, callback] of [
      ['scan-button', () => this.scan()],
      ['clear-button', () => this.setSelection([])],
      ['new-file-button', () => this.showNewFile()],
      ['help-button', () => this.showHelp()],
      ['settings-button', () => this.showSettings()],
      ['archive-button', () => this.showArchive()],
      ['sound-button', () => this.toggleSound()],
      ['modal-close', () => this.closeModal()],
      ['retry-button', () => (this.token ? this.restore() : this.newSession())],
    ])
      this.element(id)?.addEventListener('click', callback, { signal });
    this.element('modal').addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        this.closeModal();
      },
      { signal },
    );
    this.window.addEventListener(
      'focus',
      () => {
        if (this.token && this.state?.status === 'active' && !this.pending) this.restore();
      },
      { signal },
    );
    this.timer = this.window.setInterval(() => this.tick(), 1000);
    if (!this.token) return this.newSession('standard', 'Cold Harbor');
    const restored = await this.restore();
    if (!restored && [400, 401, 410, 422].includes(this.lastError?.status)) {
      this.store.saveToken(null);
      this.token = null;
      this.notify('The previous file has expired. A fresh assignment is ready.');
      return this.newSession('standard', 'Cold Harbor');
    }
    return restored;
  }

  destroy() {
    this.listeners.abort();
    this.window.clearInterval(this.timer);
    this.window.clearTimeout(this.toastTimer);
    this.sound.dispose();
  }

  async request(action) {
    if (this.pending) return false;
    this.pending = true;
    this.lastError = null;
    this.renderControls();
    try {
      const response = await action();
      this.applyResponse(response);
      if (response.feedback) {
        this.notify(response.feedback.message);
        this.sound.play(response.feedback.accepted ? 'accepted' : 'rejected');
      }
      this.element('connection-label').textContent = 'SYSTEM CONNECTED';
      return true;
    } catch (error) {
      this.lastError = error;
      this.element('connection-label').textContent = 'CONNECTION INTERRUPTED';
      this.notify(error.message || 'Unable to connect. Please try again.');
      return false;
    } finally {
      this.pending = false;
      this.renderControls();
    }
  }

  newSession(mode = 'standard', file = 'Cold Harbor') {
    return this.request(() => this.api.create(mode, file));
  }

  restore() {
    if (!this.token) return Promise.resolve(false);
    return this.request(() => this.api.restore(this.token));
  }

  applyResponse(response) {
    const previous = this.state;
    this.state = response.state;
    this.token = response.token;
    this.store.saveToken(this.token);
    this.receivedAt = this.now();
    this.selection.clear();
    this.scanned.clear();
    this.hovered.clear();
    if (previous?.id !== this.state.id) {
      this.scanUntil = 0;
      this.resultShown = null;
    }
    this.render();
    if (this.state.status !== 'active') {
      this.store.archive(this.state);
      if (this.resultShown !== this.state.id) this.showResult();
    } else if (previous && previous.id === this.state.id && previous.round < this.state.round) {
      this.notify(
        `Section ${previous.round} refined. Section ${this.state.round} is now available.`,
      );
    }
  }

  render() {
    if (!this.state) return;
    const state = this.state;
    this.element('file-name').textContent = state.file;
    this.element('mode-label').textContent = `${state.mode.toUpperCase()} REFINEMENT`;
    this.element('file-progress').textContent = `${Math.round(state.progress)}%`;
    this.element('overall-fill').style.width = `${state.progress}%`;
    this.element('overall-fill').parentElement?.setAttribute(
      'aria-valuenow',
      String(state.progress),
    );
    this.element('score-value').textContent = String(state.score).padStart(4, '0');
    this.element('streak-value').textContent = String(state.streak).padStart(2, '0');
    this.element('mistakes-value').textContent = `${state.mistakes} / ${state.max_mistakes ?? '∞'}`;
    this.element('round-value').textContent =
      `${String(state.round).padStart(2, '0')} / ${String(state.rounds).padStart(2, '0')}`;
    this.element('terminal')?.classList.toggle('is-completed', state.status === 'completed');
    this.element('terminal')?.classList.toggle('is-failed', state.status === 'failed');
    const grid = this.element('number-grid');
    const focused = this.document.activeElement?.dataset?.cell;
    const fragment = this.document.createDocumentFragment();
    const clusters = new Map();
    for (const cluster of state.board.clusters)
      for (const id of cluster.cells) clusters.set(id, cluster);
    grid.style.setProperty('--columns', String(state.board.columns));
    grid.setAttribute(
      'aria-label',
      `${state.file}, section ${state.round}. Use arrow keys to explore; Space selects a pattern.`,
    );
    for (const cell of state.board.cells) {
      const button = this.document.createElement('button');
      const cluster = clusters.get(cell.id);
      button.type = 'button';
      button.className = `number-cell${cluster ? (cluster.collected ? ' is-collected' : ' is-anomaly') : ''}`;
      button.dataset.cell = String(cell.id);
      button.textContent = String(cell.value);
      button.tabIndex = cell.id === Number(focused ?? 0) ? 0 : -1;
      button.style.setProperty('--drift-delay', `${(cell.id % 17) * -0.43}s`);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute(
        'aria-label',
        `${this.coordinates(cell.id)}, number ${cell.value}${cluster && !cluster.collected ? ', unusual pattern' : ''}${cluster?.collected ? ', refined' : ''}`,
      );
      if (cluster) button.dataset.temper = cluster.temper;
      fragment.append(button);
    }
    grid.replaceChildren(fragment);
    if (focused !== undefined)
      grid.querySelector(`[data-cell="${Number(focused)}"]`)?.focus({ preventScroll: true });
    for (const bin of state.bins) {
      const button = this.element(`bin-${bin.id}`);
      button.querySelector('[data-bin-progress]').textContent = `${Math.round(bin.progress)}%`;
      button.querySelector('[data-bin-fill]').style.width = `${bin.progress}%`;
      button.querySelector('[data-bin-count]').textContent = `${bin.count} / ${bin.capacity}`;
      button.classList.toggle('is-full', bin.progress >= 100);
      button.setAttribute(
        'aria-label',
        `Bin ${bin.id}, ${Math.round(bin.progress)} percent refined. Press ${bin.id} to send selected numbers.`,
      );
    }
    this.renderSelection();
    this.renderControls();
    this.tick();
  }

  renderControls() {
    const inactive = this.pending || this.state?.status !== 'active';
    this.element('terminal')?.classList.toggle('is-loading', this.pending);
    this.element('number-grid').setAttribute('aria-busy', String(this.pending));
    for (let bin = 1; bin <= 5; bin += 1)
      this.element(`bin-${bin}`).disabled = inactive || this.selection.size === 0;
    this.element('scan-button').disabled = inactive || this.now() < this.scanUntil;
    this.element('clear-button').disabled = inactive || this.selection.size === 0;
    this.element('new-file-button').disabled = this.pending;
    const retry = this.element('retry-button');
    if (retry) {
      retry.hidden = !this.lastError;
      retry.disabled = this.pending;
    }
    for (const button of this.element('modal-actions').querySelectorAll('button'))
      button.disabled = this.pending;
  }

  coordinates(id) {
    const columns = this.state?.board.columns || 20;
    return `X:${String((id % columns) + 1).padStart(2, '0')} Y:${String(Math.floor(id / columns) + 1).padStart(2, '0')}`;
  }

  clusterAt(id) {
    return (
      this.state?.board.clusters.find(
        (cluster) => !cluster.collected && cluster.cells.includes(id),
      ) || null
    );
  }

  matchingCluster() {
    return (
      this.state?.board.clusters.find(
        (cluster) =>
          !cluster.collected &&
          cluster.cells.length === this.selection.size &&
          cluster.cells.every((id) => this.selection.has(id)),
      ) || null
    );
  }

  selectCell(id) {
    if (this.pending || this.state?.status !== 'active') return;
    const cluster = this.clusterAt(id);
    if (cluster) {
      const alreadySelected = cluster.cells.every((cell) => this.selection.has(cell));
      this.setSelection(alreadySelected ? [] : cluster.cells);
    } else {
      const selection = new Set(this.selection);
      if (selection.has(id)) selection.delete(id);
      else selection.add(id);
      this.setSelection([...selection]);
    }
    this.element('coordinates').textContent = this.coordinates(id);
    this.sound.play('select');
  }

  setSelection(ids) {
    if (this.pending) return;
    const allowed = new Set(this.state?.board.cells.map((cell) => cell.id) || []);
    const collected = new Set(
      this.state?.board.clusters
        .filter((cluster) => cluster.collected)
        .flatMap((cluster) => cluster.cells) || [],
    );
    this.selection = new Set(ids.filter((id) => allowed.has(id) && !collected.has(id)));
    this.scanned.clear();
    this.renderSelection();
    this.renderControls();
  }

  renderSelection() {
    const cluster = this.matchingCluster();
    for (const cell of this.element('number-grid').querySelectorAll('[data-cell]')) {
      const id = Number(cell.dataset.cell);
      cell.classList.toggle('is-selected', this.selection.has(id));
      cell.classList.toggle('is-hovered', this.hovered.has(id));
      cell.classList.toggle('is-scanned', this.scanned.has(id));
      cell.setAttribute('aria-pressed', String(this.selection.has(id)));
    }
    this.element('selection-label').textContent = this.selection.size
      ? `${this.selection.size} NUMBERS SELECTED`
      : 'AWAITING SELECTION';
    this.element('selection-detail').textContent = cluster
      ? `${cluster.temper} detected · send to bin 0${cluster.bin}`
      : this.selection.size
        ? 'Pattern incomplete. Isolate a group of four unusual numbers.'
        : 'Trust the feeling. Find the numbers that feel different.';
    for (let bin = 1; bin <= 5; bin += 1)
      this.element(`bin-${bin}`).classList.toggle('is-recommended', cluster?.bin === bin);
    if (cluster)
      this.element('announcement').textContent =
        `Pattern isolated. ${cluster.temper}. Send to bin ${cluster.bin} using the bin button or number key.`;
  }

  hover(id) {
    this.hovered = new Set(this.clusterAt(id)?.cells || []);
    if (id !== null) this.element('coordinates').textContent = this.coordinates(id);
    this.renderSelection();
  }

  drag(event) {
    if (this.pointerStart === null || this.pending || this.state?.status !== 'active') return;
    let cell = event.target?.closest?.('[data-cell]');
    if (!cell) {
      const rect = this.element('number-grid').getBoundingClientRect();
      if (
        !rect.width ||
        !rect.height ||
        event.clientX < rect.left ||
        event.clientX >= rect.right ||
        event.clientY < rect.top ||
        event.clientY >= rect.bottom
      )
        return;
      const column = Math.floor(
        ((event.clientX - rect.left) / rect.width) * this.state.board.columns,
      );
      const row = Math.floor(((event.clientY - rect.top) / rect.height) * this.state.board.rows);
      cell = this.element('number-grid').querySelector(
        `[data-cell="${row * this.state.board.columns + column}"]`,
      );
    }
    if (!cell) return;
    const end = Number(cell.dataset.cell);
    if (end === this.pointerStart && !this.pointerMoved) return;
    this.pointerMoved = true;
    const columns = this.state.board.columns;
    const x1 = Math.min(this.pointerStart % columns, end % columns);
    const x2 = Math.max(this.pointerStart % columns, end % columns);
    const y1 = Math.min(Math.floor(this.pointerStart / columns), Math.floor(end / columns));
    const y2 = Math.max(Math.floor(this.pointerStart / columns), Math.floor(end / columns));
    const ids = [];
    for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) ids.push(y * columns + x);
    this.setSelection(ids);
  }

  keydown(event) {
    if (this.element('modal').open) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeModal();
      }
      return;
    }
    if (
      event.target?.matches?.('input,select,textarea,[contenteditable="true"]') ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (event.key === 'Escape') {
      this.setSelection([]);
      return;
    }
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      this.submit(Number(event.key));
      return;
    }
    const cell = event.target?.closest?.('[data-cell]');
    if (!cell || !this.state) return;
    const id = Number(cell.dataset.cell);
    const columns = this.state.board.columns;
    let target = id;
    if (event.key === 'ArrowLeft') target = Math.max(id - (id % columns), id - 1);
    else if (event.key === 'ArrowRight')
      target = Math.min(id - (id % columns) + columns - 1, id + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, id - columns);
    else if (event.key === 'ArrowDown')
      target = Math.min(this.state.board.cells.length - 1, id + columns);
    else if (event.key === 'Home') target = id - (id % columns);
    else if (event.key === 'End') target = id - (id % columns) + columns - 1;
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.selectCell(id);
      return;
    } else return;
    event.preventDefault();
    this.element('number-grid')
      .querySelector(`[data-cell="${target}"]`)
      ?.focus({ preventScroll: true });
  }

  submit(bin) {
    if (
      this.pending ||
      this.state?.status !== 'active' ||
      this.selection.size === 0 ||
      !Number.isInteger(bin) ||
      bin < 1 ||
      bin > 5
    )
      return Promise.resolve(false);
    return this.request(() =>
      this.api.refine(
        this.token,
        [...this.selection].sort((a, b) => a - b),
        bin,
      ),
    );
  }

  scan() {
    if (this.pending || this.state?.status !== 'active' || this.now() < this.scanUntil) return;
    const cluster = this.state.board.clusters.find((candidate) => !candidate.collected);
    if (!cluster) return;
    this.scanUntil = this.now() + 15000;
    this.scanned = new Set(cluster.cells);
    this.renderSelection();
    this.renderControls();
    this.notify(
      `Irregularity near ${this.coordinates(cluster.cells[0])}. Select the illuminated numbers.`,
    );
    this.sound.play('scan');
    this.tick();
  }

  tick() {
    if (!this.state) return;
    const delta =
      this.state.status === 'active'
        ? Math.max(0, Math.floor((this.now() - this.receivedAt) / 1000))
        : 0;
    const timed =
      this.state.remaining_seconds !== null && this.state.remaining_seconds !== undefined;
    const seconds = Math.max(
      0,
      Math.floor(timed ? this.state.remaining_seconds - delta : this.state.elapsed_seconds + delta),
    );
    this.element('shift-clock').textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    this.element('shift-clock').classList.toggle(
      'is-urgent',
      timed && seconds <= 60 && this.state.status === 'active',
    );
    this.element('shift-clock').setAttribute(
      'aria-label',
      `${timed ? 'Time remaining' : 'Time elapsed'}: ${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`,
    );
    const cooldown = Math.max(0, Math.ceil((this.scanUntil - this.now()) / 1000));
    this.element('scan-button').textContent = cooldown ? `SCAN · ${cooldown}s` : 'SCAN';
    this.renderControls();
    if (
      timed &&
      seconds === 0 &&
      this.state.status === 'active' &&
      !this.pending &&
      this.now() >= this.restoreAfter
    ) {
      this.restoreAfter = this.now() + 15000;
      this.restore();
    }
  }

  notify(message) {
    this.element('announcement').textContent = message;
    this.element('toast').textContent = message;
    this.element('toast').hidden = false;
    this.element('toast').classList.add('is-visible');
    this.window.clearTimeout(this.toastTimer);
    this.toastTimer = this.window.setTimeout(() => {
      this.element('toast').classList.remove('is-visible');
      this.element('toast').hidden = true;
    }, 5500);
  }

  applyPreferences() {
    const systemMotion =
      this.window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this.document.body.classList.toggle(
      'reduced-motion',
      this.preferences.reducedMotion || systemMotion,
    );
    this.sound.setEnabled(this.preferences.sound);
    this.element('sound-button').setAttribute('aria-pressed', String(this.preferences.sound));
    this.element('sound-button').setAttribute(
      'aria-label',
      `Sound ${this.preferences.sound ? 'on' : 'off'}. Toggle sound.`,
    );
    this.element('sound-button').textContent = this.preferences.sound ? 'SOUND ON' : 'SOUND OFF';
    this.store.savePreferences(this.preferences);
  }

  toggleSound() {
    this.preferences.sound = !this.preferences.sound;
    this.applyPreferences();
    this.sound.play('select');
  }

  openModal(title, content, actions = []) {
    this.modalReturnFocus = this.element('modal').open
      ? this.modalReturnFocus
      : this.document.activeElement;
    this.element('modal-title').textContent = title;
    const contentElement = this.element('modal-content');
    if (typeof content === 'string') contentElement.innerHTML = content;
    else contentElement.replaceChildren(content);
    const actionsElement = this.element('modal-actions');
    actionsElement.replaceChildren();
    for (const action of actions) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = `button${action.primary ? ' button-primary' : ''}`;
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      actionsElement.append(button);
    }
    const modal = this.element('modal');
    if (!modal.open) {
      if (typeof modal.showModal === 'function') modal.showModal();
      else modal.setAttribute('open', '');
    }
    contentElement.querySelector('select,input,button')?.focus();
  }

  closeModal() {
    const modal = this.element('modal');
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
    this.modalReturnFocus?.focus?.({ preventScroll: true });
  }

  showHelp() {
    this.openModal(
      'A brief orientation',
      `<p class="dialog-copy">Your work is mysterious. The process needn’t be. Find the small groups of numbers that glow a little differently. Refine all five bins across four sections to complete a file.</p><ol class="dialog-list"><li><strong>Find a feeling.</strong> Hover over the number field. Unusual groups react together. SCAN reveals a group every 15 seconds.</li><li><strong>Isolate the numbers.</strong> Click one unusual number to select its entire group of four, or drag a rectangle around a group.</li><li><strong>Send it home.</strong> Your selection tells you its temper and destination. Click that bin or press its number (1–5).</li></ol><p class="dialog-copy">Keyboard: Tab into the field, arrow keys to explore, Space to select, 1–5 to refine, Escape to clear. WO · Woe, FC · Frolic, DR · Dread, MA · Malice.</p><p class="dialog-copy">Standard provides 15 minutes and closes on the fifth mistake. Overtime provides 8 minutes and closes on the third mistake. Orientation is untimed and closes on the eighth mistake. Opening a dialog does not pause a timed shift. Your current file and archive are saved on this browser.</p>`,
      [{ label: 'I understand', primary: true, run: () => this.closeModal() }],
    );
  }

  showNewFile() {
    if (this.pending) return;
    const active = this.state?.status === 'active';
    this.openModal(
      active ? 'Request a new assignment' : 'Your next assignment',
      `<p class="dialog-copy">${active ? 'Starting a new file replaces your current assignment. The current file’s progress will be lost.' : 'A clean desk. A new file. A chance to do something important.'}</p><label class="dialog-field" for="assignment-file">FILE<select class="dialog-select" id="assignment-file"><option>Cold Harbor</option><option>Dranesville</option><option>Siena</option><option>Allentown</option><option>Wellington</option></select></label><label class="dialog-field" for="assignment-mode">SHIFT<select class="dialog-select" id="assignment-mode"><option value="standard">Standard · 15 minutes · 5-strike limit</option><option value="overtime">Overtime · 8 minutes · 3-strike limit</option><option value="orientation">Orientation · untimed · 8-strike limit</option></select></label>`,
      [
        { label: 'Cancel', run: () => this.closeModal() },
        {
          label: active ? 'Replace current file' : 'Begin refinement',
          primary: true,
          run: async () => {
            const mode = this.element('assignment-mode').value;
            const file = this.element('assignment-file').value;
            if (await this.newSession(mode, file)) this.closeModal();
          },
        },
      ],
    );
  }

  showSettings() {
    this.openModal(
      'Terminal preferences',
      `<p class="dialog-copy">Make yourself comfortable. Preferences are saved on this browser.</p><label class="dialog-option"><input id="preference-sound" type="checkbox" ${this.preferences.sound ? 'checked' : ''}> Procedural terminal sound</label><label class="dialog-option"><input id="preference-motion" type="checkbox" ${this.preferences.reducedMotion ? 'checked' : ''}> Reduce animation and screen effects</label><p class="dialog-copy">Your device’s reduced-motion setting is always respected.</p>`,
      [
        {
          label: 'Save preferences',
          primary: true,
          run: () => {
            this.preferences.sound = this.element('preference-sound').checked;
            this.preferences.reducedMotion = this.element('preference-motion').checked;
            this.applyPreferences();
            this.closeModal();
          },
        },
      ],
    );
  }

  showArchive() {
    const fragment = this.document.createDocumentFragment();
    const intro = this.document.createElement('p');
    intro.className = 'dialog-copy';
    intro.textContent = 'Your last 30 closed assignments, stored only on this browser.';
    fragment.append(intro);
    const history = this.store.history();
    if (!history.length) {
      const empty = this.document.createElement('p');
      empty.className = 'archive-empty';
      empty.textContent = 'The archive is quiet. Your first completed file will appear here.';
      fragment.append(empty);
    }
    for (const entry of history) {
      const row = this.document.createElement('div');
      row.className = 'archive-row';
      const name = this.document.createElement('strong');
      name.textContent = entry.file;
      const detail = this.document.createElement('span');
      detail.textContent = `${entry.status === 'completed' ? 'REFINED' : 'CLOSED'} · ${entry.mode} · ${entry.score} points`;
      row.append(name, detail);
      fragment.append(row);
    }
    this.openModal('Personnel archive', fragment, [
      { label: 'Return to work', primary: true, run: () => this.closeModal() },
    ]);
  }

  showResult() {
    this.resultShown = this.state.id;
    const completed = this.state.status === 'completed';
    const fragment = this.document.createDocumentFragment();
    const badge = this.document.createElement('div');
    badge.className = 'result-badge';
    badge.textContent = completed ? '100% REFINED' : 'ASSIGNMENT CLOSED';
    const copy = this.document.createElement('p');
    copy.className = 'dialog-copy';
    copy.textContent = completed
      ? `${this.state.file} is complete. Every number is where it belongs. Your diligence has been noted. A waffle party has been approved in your honor.`
      : 'This file has reached its shift limit. Take a breath. A fresh assignment awaits, and Orientation mode gives you all the time you need.';
    const stats = this.document.createElement('p');
    stats.className = 'dialog-stat';
    stats.textContent = `${this.state.score} POINTS · ${this.state.mistakes} MISTAKES · ${Math.floor(this.state.elapsed_seconds / 60)}m ${this.state.elapsed_seconds % 60}s`;
    fragment.append(badge, copy, stats);
    this.openModal(
      completed ? 'The work is mysterious. And complete.' : 'There is always another file.',
      fragment,
      [
        { label: 'Review terminal', run: () => this.closeModal() },
        { label: 'Next assignment', primary: true, run: () => this.showNewFile() },
      ],
    );
    if (completed) this.sound.play('complete');
  }
}
