/** Deterministic number field, camera mathematics, and time-based cluster motion. */
export const CELL_WIDTH = 36;
export const CELL_HEIGHT = 42;

export class Camera {
  constructor(width, height, columns = 256, rows = 160) {
    this.columns = columns;
    this.rows = rows;
    this.width = width;
    this.height = height;
    this.x = (columns * CELL_WIDTH) / 2;
    this.y = (rows * CELL_HEIGHT) / 2;
    this.zoom = 1;
    this.clamp();
  }
  clamp() {
    this.zoom = Math.max(0.5, Math.min(3, this.zoom));
    const halfX = Math.min(this.width / (2 * this.zoom), (this.columns * CELL_WIDTH) / 2);
    const halfY = Math.min(this.height / (2 * this.zoom), (this.rows * CELL_HEIGHT) / 2);
    this.x = Math.max(halfX, Math.min(this.columns * CELL_WIDTH - halfX, this.x));
    this.y = Math.max(halfY, Math.min(this.rows * CELL_HEIGHT - halfY, this.y));
  }
  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.clamp();
  }
  pan(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }
  worldToScreen(x, y) {
    return {
      x: (x - this.x) * this.zoom + this.width / 2,
      y: (y - this.y) * this.zoom + this.height / 2,
    };
  }
  screenToWorld(x, y) {
    return {
      x: (x - this.width / 2) / this.zoom + this.x,
      y: (y - this.height / 2) / this.zoom + this.y,
    };
  }
  zoomAt(factor, x, y) {
    const before = this.screenToWorld(x, y);
    this.zoom = Math.max(0.5, Math.min(3, this.zoom * factor));
    const after = this.screenToWorld(x, y);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }
  visibleBounds(pad = 2) {
    const left = this.screenToWorld(0, 0),
      right = this.screenToWorld(this.width, this.height);
    return {
      left: Math.max(0, Math.floor(left.x / CELL_WIDTH) - pad),
      top: Math.max(0, Math.floor(left.y / CELL_HEIGHT) - pad),
      right: Math.min(this.columns, Math.ceil(right.x / CELL_WIDTH) + pad),
      bottom: Math.min(this.rows, Math.ceil(right.y / CELL_HEIGHT) + pad),
    };
  }
  snapshot() {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }
  restore(value) {
    if (!value || !['x', 'y', 'zoom'].every((key) => Number.isFinite(value[key]))) return false;
    this.x = value.x;
    this.y = value.y;
    this.zoom = value.zoom;
    this.clamp();
    return true;
  }
}

export class ClusterMotion {
  constructor(cluster, x, y, now) {
    this.cluster = cluster;
    this.origin = { x, y };
    this.anchor = { x, y };
    this.target = { x, y };
    this.startedAt = now;
    this.movedAt = now;
    this.releasedAt = null;
    this.releaseProgress = 0;
  }
  progress(now) {
    return this.releasedAt === null
      ? Math.max(0, Math.min(1, (now - this.startedAt) / 1500))
      : Math.max(0, this.releaseProgress * (1 - (now - this.releasedAt) / 450));
  }
  anchorAt(now) {
    const t = 1 - Math.exp(-Math.max(0, now - this.movedAt) / 100);
    return {
      x: this.anchor.x + (this.target.x - this.anchor.x) * t,
      y: this.anchor.y + (this.target.y - this.anchor.y) * t,
    };
  }
  move(x, y, now) {
    this.anchor = this.anchorAt(now);
    this.target = { x, y };
    this.movedAt = now;
  }
  leave(now) {
    if (this.releasedAt === null) {
      this.releaseProgress = this.progress(now);
      this.releasedAt = now;
    }
  }
  ready(now) {
    return this.releasedAt === null && this.progress(now) >= 1;
  }
  position(index, base, now, reducedMotion = false) {
    const p = this.progress(now),
      ease = p * p * (3 - 2 * p),
      anchor = this.anchorAt(now);
    const radius = Math.sqrt(index + 1) * 19,
      angle = index * 2.39996;
    return {
      x: reducedMotion ? base.x : base.x + (anchor.x + Math.cos(angle) * radius - base.x) * ease,
      y: reducedMotion ? base.y : base.y + (anchor.y + Math.sin(angle) * radius - base.y) * ease,
      scale: 1 + p * 0.85,
    };
  }
}

export class NumberField {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.effectCanvas = options.effectsCanvas || canvas;
    this.effectContext = options.effectsCanvas
      ? options.effectsCanvas.getContext('2d')
      : this.context;
    this.camera = new Camera(1, 1);
    this.world = { seed: 1, columns: 256, rows: 160, clusters: [] };
    this.clusterCells = new Map();
    this.replacements = new Map();
    this.motion = null;
    this.particles = [];
    this.reducedMotion = !!options.reducedMotion;
    this.visibleCount = 0;
    this.dpr = 1;
  }
  resize(width, height, dpr = 1) {
    this.dpr = Math.max(1, Math.min(2, dpr));
    this.camera.resize(width, height);
    for (const canvas of new Set([this.canvas, this.effectCanvas])) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
  }
  setWorld(world) {
    this.world = world;
    this.camera.columns = world.columns;
    this.camera.rows = world.rows;
    this.camera.clamp();
    this.clusterCells.clear();
    for (const cluster of world.clusters)
      if (cluster.active) for (const id of cluster.cells) this.clusterCells.set(id, cluster);
    if (
      this.motion &&
      !world.clusters.some((cluster) => cluster.active && cluster.id === this.motion.cluster.id)
    )
      this.motion = null;
  }
  value(id) {
    if (this.replacements.has(id)) return this.replacements.get(id);
    let value = Math.imul((id + 1) ^ this.world.seed, 1597334677);
    value = Math.imul(value ^ (value >>> 16), 2246822519);
    return (value >>> 0) % 10;
  }
  basePosition(id, now) {
    const scary = this.clusterCells.has(id),
      phase = id * 1.173 + (this.world.seed % 91);
    const amplitude = this.reducedMotion ? 0 : scary ? 4 : 2.4;
    return this.camera.worldToScreen(
      ((id % this.world.columns) + 0.5) * CELL_WIDTH +
        Math.sin(now / (scary ? 720 : 1800) + phase) * amplitude,
      (Math.floor(id / this.world.columns) + 0.5) * CELL_HEIGHT +
        Math.cos(now / 1600 + phase) * amplitude,
    );
  }
  hitTest(x, y, now) {
    if (this.motion)
      for (let i = 0; i < this.motion.cluster.cells.length; i++) {
        const id = this.motion.cluster.cells[i],
          p = this.motion.position(i, this.basePosition(id, now), now, this.reducedMotion);
        if (
          Math.abs(x - p.x) < 13 * p.scale * this.camera.zoom &&
          Math.abs(y - p.y) < 17 * p.scale * this.camera.zoom
        )
          return { id, cluster: this.motion.cluster };
      }
    const world = this.camera.screenToWorld(x, y),
      column = Math.floor(world.x / CELL_WIDTH),
      row = Math.floor(world.y / CELL_HEIGHT);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = column + dx,
          cy = row + dy;
        if (cx < 0 || cy < 0 || cx >= this.world.columns || cy >= this.world.rows) continue;
        const id = cy * this.world.columns + cx,
          p = this.basePosition(id, now);
        if (Math.abs(x - p.x) < 15 * this.camera.zoom && Math.abs(y - p.y) < 19 * this.camera.zoom)
          return { id, cluster: this.clusterCells.get(id) || null };
      }
    return null;
  }
  hover(x, y, now) {
    if (
      this.motion &&
      this.motion.releasedAt === null &&
      Math.hypot(x - this.motion.origin.x, y - this.motion.origin.y) < 155
    ) {
      this.motion.move(x, y, now);
      return this.motion.cluster;
    }
    this.leave(now);
    const hit = this.hitTest(x, y, now);
    if (hit?.cluster && (!this.motion || hit.cluster.id !== this.motion.cluster.id))
      this.motion = new ClusterMotion(hit.cluster, x, y, now);
    return this.motion?.releasedAt === null ? this.motion.cluster : null;
  }
  leave(now) {
    this.motion?.leave(now);
  }
  readyCluster(now) {
    return this.motion?.ready(now) ? this.motion.cluster : null;
  }
  replace(cells, generation = 0) {
    for (const id of cells) this.replacements.set(id, (this.value(id) + 1 + (generation % 8)) % 10);
  }
  capture(cluster, target, now) {
    for (let index = 0; index < cluster.cells.length; index++) {
      const id = cluster.cells[index],
        base = this.basePosition(id, now);
      const from =
        this.motion?.cluster.id === cluster.id
          ? this.motion.position(index, base, now, this.reducedMotion)
          : base;
      this.particles.push({
        from,
        target: { ...target },
        value: this.value(id),
        startedAt: now + index * 12,
        duration: this.reducedMotion ? 100 : 680,
      });
    }
    this.replace(cluster.cells, cluster.generation + 1);
    this.motion = null;
  }
  setReducedMotion(value) {
    this.reducedMotion = !!value;
  }
  draw(now) {
    const ctx = this.context,
      width = this.camera.width,
      height = this.camera.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#061726';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${22 * this.camera.zoom}px "Courier New", monospace`;
    const bounds = this.camera.visibleBounds();
    this.visibleCount = 0;
    for (let row = bounds.top; row < bounds.bottom; row++)
      for (let column = bounds.left; column < bounds.right; column++) {
        const id = row * this.world.columns + column,
          p = this.basePosition(id, now);
        ctx.fillStyle = this.clusterCells.has(id) ? '#9dcbd8' : '#88bacf';
        ctx.fillText(String(this.value(id)), p.x, p.y);
        this.visibleCount++;
      }
    if (this.motion) {
      const progress = this.motion.progress(now);
      if (this.motion.releasedAt !== null && progress === 0) this.motion = null;
      else {
        for (let i = 0; i < this.motion.cluster.cells.length; i++) {
          const id = this.motion.cluster.cells[i],
            p = this.motion.position(i, this.basePosition(id, now), now, this.reducedMotion);
          ctx.font = `${22 * this.camera.zoom * p.scale}px "Courier New", monospace`;
          ctx.fillStyle = this.motion.ready(now) ? '#e0f8f6' : '#bce5eb';
          ctx.fillText(String(this.value(id)), p.x, p.y);
        }
        const anchor = this.motion.anchorAt(now);
        ctx.strokeStyle = this.motion.ready(now) ? '#d5f0d9' : '#8fb9c9';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(anchor.x, anchor.y, 9, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
      }
    }
    const fx = this.effectContext;
    fx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.effectCanvas !== this.canvas) fx.clearRect(0, 0, width, height);
    fx.textAlign = 'center';
    fx.textBaseline = 'middle';
    fx.font = '23px "Courier New", monospace';
    this.particles = this.particles.filter(
      (particle) => now < particle.startedAt + particle.duration,
    );
    for (const particle of this.particles) {
      const p = Math.max(0, Math.min(1, (now - particle.startedAt) / particle.duration)),
        t = p * p;
      fx.fillStyle = '#ddf7ee';
      fx.globalAlpha = 1 - p * 0.6;
      fx.fillText(
        String(particle.value),
        particle.from.x + (particle.target.x - particle.from.x) * t,
        particle.from.y + (particle.target.y - particle.from.y) * t - Math.sin(p * Math.PI) * 70,
      );
    }
    fx.globalAlpha = 1;
  }
  dispose() {
    this.motion = null;
    this.particles = [];
    this.clusterCells.clear();
    this.replacements.clear();
  }
}
