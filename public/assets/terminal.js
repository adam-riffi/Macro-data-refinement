import { NumberField, CELL_WIDTH, CELL_HEIGHT } from './field.js';
import { RefinementApi, LocalSessionStore, TerminalAudio } from './session.js';

/** Owns one terminal's input, rendering lifecycle, and serialized server updates. */
export class RefinementTerminal {
  constructor(document, window, dependencies = {}) {
    this.document = document;
    this.window = window;
    this.api = dependencies.api || new RefinementApi();
    let storage;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    this.store = dependencies.store || new LocalSessionStore(storage);
    this.audio = dependencies.audio || new TerminalAudio(window);
    this.canvas = this.element('number-field');
    this.field =
      dependencies.field ||
      new NumberField(this.canvas, { effectsCanvas: this.element('flight-layer') });
    this.state = null;
    this.token = this.store.token();
    this.busy = false;
    this.destroyed = false;
    this.pointers = new Map();
    this.gesture = null;
    this.listeners = [];
    this.lastFrame = 0;
    this.lastClock = -1;
    this.receivedAt = 0;
    this.lastSave = 0;
    this.retry = null;
    this.focusIndex = -1;
    this.gatheringFeedback = false;
  }
  element(id) {
    return this.document.getElementById(id);
  }
  listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this.listeners.push([target, event, handler, options]);
  }
  async init() {
    const preferences = this.store.preferences();
    preferences.reducedMotion ||=
      this.window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    this.element('sound-setting').checked = preferences.sound;
    this.element('motion-setting').checked = preferences.reducedMotion;
    this.configure();
    this.resize();
    this.listen(this.window, 'resize', () => this.resize());
    this.listen(this.window, 'pagehide', () => this.saveView());
    this.listen(this.document, 'visibilitychange', () => {
      if (this.document.hidden) this.saveView();
      else if (this.token && !this.busy) this.connect();
    });
    for (const [event, method] of [
      ['pointerdown', 'pointerDown'],
      ['pointermove', 'pointerMove'],
      ['pointerup', 'pointerUp'],
      ['pointercancel', 'pointerCancel'],
    ])
      this.listen(this.canvas, event, (e) => this[method](e));
    this.listen(this.canvas, 'pointerleave', () => {
      if (!this.pointers.size) this.field.leave(this.window.performance.now());
    });
    this.listen(this.canvas, 'wheel', (e) => this.wheel(e), { passive: false });
    this.listen(this.document, 'keydown', (e) => this.keydown(e));
    for (const panel of ['assignment', 'settings', 'help', 'history'])
      this.listen(this.element(`${panel}-button`), 'click', () => this.openDialog(panel));
    this.listen(this.element('next-assignment'), 'click', () => this.openDialog('assignment'));
    this.listen(this.element('close-dialog'), 'click', () => this.closeDialog());
    this.listen(this.element('terminal-dialog'), 'close', () => this.canvas.focus());
    this.listen(this.element('assignment-form'), 'submit', (e) => {
      e.preventDefault();
      this.startAssignment();
    });
    for (const setting of ['sound', 'motion'])
      this.listen(this.element(`${setting}-setting`), 'change', () => this.configure());
    for (const [id, factor] of [
      ['zoom-in', 1.25],
      ['zoom-out', 0.8],
    ])
      this.listen(this.element(id), 'click', () => this.zoom(factor));
    this.listen(this.element('signals-button'), 'click', () => this.focusSignal());
    this.listen(this.element('retry-button'), 'click', () => this.retry?.());
    this.animation = this.window.requestAnimationFrame((now) => this.frame(now));
    await this.connect();
  }
  resize() {
    this.field.resize(
      this.window.innerWidth,
      this.window.innerHeight,
      this.window.devicePixelRatio || 1,
    );
    this.renderCamera();
  }
  frame(now) {
    if (this.destroyed) return;
    if (!this.document.hidden && now - this.lastFrame >= 1000 / 60) {
      this.field.draw(now);
      this.lastFrame = now;
      const motion = this.field.motion;
      if (motion?.releasedAt === null && !this.busy) {
        this.gatheringFeedback = true;
        const ready = motion.ready(now);
        this.element('feedback').textContent = ready
          ? `${motion.cluster.cells.length} NUMBERS · CLICK TO REFINE`
          : `IDENTIFYING ${Math.floor(motion.progress(now) * 100)}% · STAY CLOSE`;
      } else if (this.gatheringFeedback && !this.busy)
        this.notify('Signal released. Continue refinement.');
      const second = Math.floor(now / 1000);
      if (second !== this.lastClock) {
        this.renderClock(now);
        this.lastClock = second;
      }
      if (now - this.lastSave >= 1500) {
        this.saveView();
        this.lastSave = now;
      }
    }
    this.animation = this.window.requestAnimationFrame((next) => this.frame(next));
  }
  async transact(operation, cluster = null) {
    if (this.busy || this.destroyed) return false;
    this.busy = true;
    this.element('start-button').disabled = true;
    this.element('retry-button').hidden = true;
    this.element('dialog-feedback').textContent = '';
    try {
      const envelope = await operation();
      if (this.destroyed) return false;
      if (cluster && envelope.feedback?.accepted) {
        const rect = this.element(`bin-${envelope.feedback.bin}`).getBoundingClientRect();
        this.field.capture(
          cluster,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          this.window.performance.now(),
        );
      }
      this.applyState(envelope);
      this.retry = null;
      return true;
    } catch (error) {
      this.notify(error.message);
      this.element('dialog-feedback').textContent = error.message;
      this.retry = () => this.transact(operation, cluster);
      const button = this.element('retry-button');
      button.hidden = false;
      if (error.status === 400 || error.status === 410) {
        button.textContent = 'SAVE UNAVAILABLE · OPEN A NEW FILE';
        this.retry = () => this.openDialog('assignment');
      } else button.textContent = 'CONNECTION INTERRUPTED · RETRY';
      return false;
    } finally {
      this.busy = false;
      this.element('start-button').disabled = false;
    }
  }
  connect() {
    return this.transact(() => (this.token ? this.api.restore(this.token) : this.api.create()));
  }
  async startAssignment() {
    const mode = this.element('new-mode').value,
      difficulty = this.element('new-difficulty').value,
      file = this.element('new-file').value;
    const success = await this.transact(() => this.api.create(mode, difficulty, file));
    if (success) this.closeDialog();
  }
  applyState(envelope) {
    const previousId = this.state?.id;
    const newlyClosed =
      envelope.state.status !== 'active' &&
      (previousId !== envelope.state.id || this.state?.status === 'active');
    this.state = envelope.state;
    this.token = envelope.token;
    this.receivedAt = this.window.performance.now();
    this.store.saveToken(this.token);
    if (previousId !== this.state.id) {
      this.field.dispose();
      this.field.camera.restore({ x: 4608, y: 3360, zoom: 1 });
      const saved = this.store.view(this.state.id);
      if (saved) {
        this.field.camera.restore(saved.camera);
        this.field.replacements = new Map(saved.replacements);
      }
    }
    this.field.setWorld(this.state.world);
    this.render();
    this.saveView();
    if (envelope.feedback) {
      const feedback = envelope.feedback;
      this.notify(
        `${feedback.message}${feedback.points ? ` ${feedback.points > 0 ? '+' : ''}${feedback.points} PTS` : ''}`,
      );
      this.audio.play(feedback.accepted ? 'capture' : 'reject');
    } else
      this.notify(
        this.state.status === 'active'
          ? 'THE NUMBERS ARE WAITING. TRUST YOUR INSTINCTS.'
          : 'FILE CLOSED. OPEN ANOTHER ASSIGNMENT TO CONTINUE.',
      );
    if (newlyClosed) {
      this.store.archive(this.state);
      this.audio.play(this.state.status === 'completed' ? 'complete' : 'reject');
      this.openDialog('result');
    }
  }
  render() {
    const state = this.state;
    this.element('file-name').textContent = state.file;
    const mode = {
      quota: 'QUOTA',
      timed: 'TIMED SHIFT',
      endless: `ENDLESS / CYCLE ${state.cycle}`,
    }[state.mode];
    const difficulty = {
      normal: 'NORMAL',
      quota_achiever: 'QUOTA ACHIEVER',
      quarter_refiner: `QUARTER REFINER / ${state.mistakes} OF 3 STRIKES`,
    }[state.difficulty];
    this.element('assignment-label').textContent = `${mode} / ${difficulty}`;
    this.element('completion').textContent = `${Math.floor(state.progress)}% COMPLETE`;
    this.element('overall-progress').value = state.progress;
    this.element('score').textContent = `${String(state.score).padStart(6, '0')} PTS`;
    for (const bin of state.bins) {
      this.element(`bin-count-${bin.id}`).textContent =
        `${String(bin.count).padStart(3, '0')} / 100`;
      this.element(`bin-progress-${bin.id}`).value = bin.progress;
    }
    this.renderCamera();
    this.renderClock(this.receivedAt);
  }
  renderCamera() {
    const camera = this.field.camera;
    const column = Math.floor(camera.x / CELL_WIDTH),
      row = Math.floor(camera.y / CELL_HEIGHT);
    this.element('zoom-label').textContent = `${Math.round(camera.zoom * 100)}%`;
    this.element('sector').textContent =
      `${String(column).padStart(3, '0')}:${String(row).padStart(3, '0')}`;
    this.element('coordinates').textContent =
      `0x${column.toString(16).padStart(4, '0')} : 0x${row.toString(16).padStart(4, '0')}`;
    const map = this.element('map'),
      ctx = map.getContext('2d');
    ctx.clearRect(0, 0, map.width, map.height);
    ctx.strokeStyle = '#29485e';
    ctx.lineWidth = 1;
    for (let x = 0; x <= map.width; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, map.height);
      ctx.stroke();
    }
    for (let y = 0; y <= map.height; y += 8) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(map.width, y);
      ctx.stroke();
    }
    const bounds = camera.visibleBounds(0);
    ctx.strokeStyle = '#c6e4e7';
    ctx.strokeRect(
      (bounds.left / 256) * map.width,
      (bounds.top / 160) * map.height,
      ((bounds.right - bounds.left) / 256) * map.width,
      ((bounds.bottom - bounds.top) / 160) * map.height,
    );
  }
  renderClock(now) {
    if (!this.state) return;
    if (this.state.mode !== 'timed') {
      this.element('run-clock').textContent =
        this.state.status === 'active' ? 'UNTIMED' : 'FILE CLOSED';
      return;
    }
    const passed = this.state.status === 'active' ? Math.floor((now - this.receivedAt) / 1000) : 0;
    const remaining = Math.max(0, this.state.remaining_seconds - passed);
    this.element('run-clock').textContent =
      `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    if (remaining === 0 && this.state.status === 'active' && !this.busy && !this.retry)
      this.connect();
  }
  notify(message) {
    this.gatheringFeedback = false;
    this.element('feedback').textContent = message.toUpperCase();
    this.element('announcer').textContent = message;
  }
  pointerDown(event) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.gesture = {
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragged: false,
        multi: false,
      };
      if (event.pointerType === 'touch' && !this.busy)
        this.field.hover(event.clientX, event.clientY, this.window.performance.now());
    } else {
      this.gesture.multi = true;
      this.field.leave(this.window.performance.now());
    }
  }
  pointerMove(event) {
    const now = this.window.performance.now();
    if (!this.pointers.has(event.pointerId)) {
      if (!this.busy && !this.element('terminal-dialog').open && this.state?.status === 'active')
        this.field.hover(event.clientX, event.clientY, now);
      return;
    }
    const previous = [...this.pointers.values()];
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size >= 2) {
      const current = [...this.pointers.values()];
      const distance = Math.hypot(previous[0].x - previous[1].x, previous[0].y - previous[1].y);
      const next = Math.hypot(current[0].x - current[1].x, current[0].y - current[1].y);
      const x = (current[0].x + current[1].x) / 2,
        y = (current[0].y + current[1].y) / 2;
      this.field.camera.pan(
        x - (previous[0].x + previous[1].x) / 2,
        y - (previous[0].y + previous[1].y) / 2,
      );
      if (distance > 0 && next > 0) this.field.camera.zoomAt(next / distance, x, y);
      this.gesture.dragged = true;
    } else if (this.gesture && !this.gesture.multi) {
      const gesture = this.gesture;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 7)
        gesture.dragged = true;
      if (gesture.dragged) {
        this.field.leave(now);
        this.field.camera.pan(event.clientX - gesture.lastX, event.clientY - gesture.lastY);
        this.canvas.classList.add('dragging');
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
    }
    this.renderCamera();
  }
  pointerUp(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const gesture = this.gesture;
    this.pointers.delete(event.pointerId);
    if (!gesture.dragged && !gesture.multi) this.refine(event.clientX, event.clientY);
    if (!this.pointers.size) {
      this.gesture = null;
      this.canvas.classList.remove('dragging');
      this.saveView();
    }
    if (event.pointerType === 'touch') this.field.leave(this.window.performance.now());
  }
  pointerCancel(event) {
    this.pointers.delete(event.pointerId);
    if (this.gesture) this.gesture.multi = true;
    if (!this.pointers.size) {
      this.gesture = null;
      this.canvas.classList.remove('dragging');
    }
    this.field.leave(this.window.performance.now());
  }
  wheel(event) {
    event.preventDefault();
    this.field.leave(this.window.performance.now());
    this.field.camera.zoomAt(
      Math.exp(-Math.max(-400, Math.min(400, event.deltaY)) * 0.0015),
      event.clientX,
      event.clientY,
    );
    this.renderCamera();
  }
  zoom(factor) {
    this.field.leave(this.window.performance.now());
    this.field.camera.zoomAt(factor, this.window.innerWidth / 2, this.window.innerHeight / 2);
    this.renderCamera();
    this.saveView();
  }
  keydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      this.element('terminal-dialog').open ||
      /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)
    )
      return;
    const key = event.key.toLowerCase(),
      steps = {
        arrowleft: [90, 0],
        a: [90, 0],
        arrowright: [-90, 0],
        d: [-90, 0],
        arrowup: [0, 90],
        w: [0, 90],
        arrowdown: [0, -90],
        s: [0, -90],
      };
    if (steps[key]) {
      event.preventDefault();
      this.field.leave(this.window.performance.now());
      this.field.camera.pan(...steps[key]);
      this.renderCamera();
    } else if (key === '+' || key === '=' || key === '-') {
      event.preventDefault();
      this.zoom(key === '-' ? 0.8 : 1.25);
    } else if (key === 'f') {
      event.preventDefault();
      this.focusSignal();
    } else if (key === 'enter' || key === ' ') {
      event.preventDefault();
      this.refine();
    } else if (key === '?') this.openDialog('help');
  }
  focusSignal() {
    if (!this.state || this.state.status !== 'active' || this.busy) return;
    const top = this.element('help-button').getBoundingClientRect().bottom + 12;
    const bottom = this.element('feedback').getBoundingClientRect().top - 12;
    const now = this.window.performance.now();
    const candidates = [];
    for (const cluster of this.state.world.clusters) {
      if (!cluster.active) continue;
      for (const id of cluster.cells) {
        const p = this.field.basePosition(id, now);
        if (p.x > 25 && p.x < this.window.innerWidth - 25 && p.y > top && p.y < bottom) {
          candidates.push({ cluster, p });
          break;
        }
      }
    }
    if (!candidates.length) {
      this.notify('No signal in this viewport. Navigate to another sector.');
      return;
    }
    this.focusIndex = (this.focusIndex + 1) % candidates.length;
    const { p } = candidates[this.focusIndex];
    this.field.motion = null;
    this.field.hover(p.x, p.y, now);
    this.canvas.focus();
    this.notify('Visible signal focused. Wait 1.5 seconds, then press Enter to refine.');
  }
  refine(x, y) {
    if (this.busy || this.state?.status !== 'active' || this.element('terminal-dialog').open)
      return;
    const now = this.window.performance.now(),
      cluster = this.field.readyCluster(now);
    if (cluster) {
      this.transact(() => this.api.capture(this.token, cluster.id), cluster);
      return;
    }
    if (this.field.motion?.releasedAt === null) {
      this.notify('Let the signal spread. Early clicks carry no penalty.');
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.focusSignal();
      return;
    }
    const hit = this.field.hitTest(x, y, now);
    if (hit?.cluster) {
      this.field.hover(x, y, now);
      return;
    }
    if (hit) this.transact(() => this.api.mistake(this.token, hit.id));
  }
  saveView() {
    if (this.state)
      this.store.saveView(this.state.id, {
        camera: this.field.camera.snapshot(),
        replacements: [...this.field.replacements],
      });
  }
  configure() {
    const preferences = {
      sound: this.element('sound-setting').checked,
      reducedMotion: this.element('motion-setting').checked,
    };
    this.store.savePreferences(preferences);
    this.field.setReducedMotion(preferences.reducedMotion);
    this.audio.setEnabled(preferences.sound);
  }
  openDialog(panel) {
    this.element('dialog-feedback').textContent = '';
    this.field.leave(this.window.performance.now());
    for (const name of ['assignment', 'settings', 'help', 'history', 'result'])
      this.element(`${name}-panel`).hidden = name !== panel;
    this.element('dialog-title').textContent = {
      assignment: 'FILE ASSIGNMENT',
      settings: 'TERMINAL CONFIGURATION',
      help: 'REFINEMENT PROTOCOL',
      history: 'REFINEMENT LOG',
      result: 'FILE ASSESSMENT',
    }[panel];
    if (panel === 'assignment' && this.state) {
      this.element('new-mode').value = this.state.mode;
      this.element('new-difficulty').value = this.state.difficulty;
    }
    if (panel === 'history') {
      const list = this.element('history-list');
      list.replaceChildren();
      const history = this.store.history();
      if (!history.length) {
        const li = this.document.createElement('li');
        li.textContent = 'NO CLOSED FILES ON RECORD.';
        list.append(li);
      }
      for (const entry of history) {
        const li = this.document.createElement('li');
        li.textContent = `${entry.file} / ${entry.status} / ${entry.score} PTS / ${entry.mode} / ${entry.difficulty}`;
        list.append(li);
      }
    }
    if (panel === 'result')
      this.element('result-summary').textContent =
        `${this.state.status === 'completed' ? 'QUOTA MET. YOUR WORK IS APPRECIATED.' : 'THIS SHIFT HAS ENDED.'} ${this.state.refined_digits} numbers refined. ${this.state.score} points. ${Math.floor(this.state.progress)}% complete.`;
    const dialog = this.element('terminal-dialog');
    if (!dialog.open) dialog.showModal();
  }
  closeDialog() {
    this.element('terminal-dialog').close();
    this.canvas.focus();
  }
  destroy() {
    this.saveView();
    this.destroyed = true;
    this.window.cancelAnimationFrame(this.animation);
    for (const [target, event, handler, options] of this.listeners)
      target.removeEventListener(event, handler, options);
    this.listeners = [];
    this.pointers.clear();
    this.field.dispose();
    this.audio.dispose();
  }
}
