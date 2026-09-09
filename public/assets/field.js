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
    if (this.x < 0 || this.x >= this.columns * CELL_WIDTH)
      this.x =
        ((this.x % (this.columns * CELL_WIDTH)) + this.columns * CELL_WIDTH) %
        (this.columns * CELL_WIDTH);
    if (this.y < 0 || this.y >= this.rows * CELL_HEIGHT)
      this.y =
        ((this.y % (this.rows * CELL_HEIGHT)) + this.rows * CELL_HEIGHT) %
        (this.rows * CELL_HEIGHT);
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
      x:
        (x -
          this.x -
          Math.round((x - this.x) / (this.columns * CELL_WIDTH)) * this.columns * CELL_WIDTH) *
          this.zoom +
        this.width / 2,
      y:
        (y -
          this.y -
          Math.round((y - this.y) / (this.rows * CELL_HEIGHT)) * this.rows * CELL_HEIGHT) *
          this.zoom +
        this.height / 2,
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
      left: Math.floor(left.x / CELL_WIDTH) - pad,
      top: Math.floor(left.y / CELL_HEIGHT) - pad,
      right: Math.ceil(right.x / CELL_WIDTH) + pad,
      bottom: Math.ceil(right.y / CELL_HEIGHT) + pad,
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
  position(index, base, now, reducedMotion = false, zoom = 1) {
    const distance = Math.hypot(base.x - this.origin.x, base.y - this.origin.y) / zoom;
    const delay = Math.min(850, distance * 5);
    const p =
      this.releasedAt === null
        ? Math.max(0, Math.min(1, (now - this.startedAt - delay) / 1000))
        : this.progress(now);
    const phase = index * 2.39996;
    const agitation = p * zoom;
    return {
      x:
        base.x +
        (reducedMotion
          ? 0
          : (Math.sin(now / 137 + phase) + Math.sin(now / 59 + phase) * 0.35) * agitation * 1.6),
      y:
        base.y +
        (reducedMotion
          ? 0
          : (Math.cos(now / 173 + phase) + Math.sin(now / 83 + phase) * 0.3) * agitation * 1.3),
      scale: 1 + p * 0.06,
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
    this.refills = new Map();
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
          p = this.motion.position(
            i,
            this.basePosition(id, now),
            now,
            this.reducedMotion,
            this.camera.zoom,
          );
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
        const cx = (((column + dx) % this.world.columns) + this.world.columns) % this.world.columns,
          cy = (((row + dy) % this.world.rows) + this.world.rows) % this.world.rows;
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
      this.motion.cluster.cells.some((id) => {
        const p = this.basePosition(id, now);
        return Math.hypot(x - p.x, y - p.y) < 42 * this.camera.zoom;
      })
    ) {
      this.motion.move(x, y, now);
      return this.motion.cluster;
    }
    this.leave(now);
    const hit = this.hitTest(x, y, now);
    if (hit?.cluster) {
      const origin = this.basePosition(hit.id, now);
      this.motion = new ClusterMotion(hit.cluster, origin.x, origin.y, now);
    }
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
          ? this.motion.position(index, base, now, this.reducedMotion, this.camera.zoom)
          : base;
      this.particles.push({
        from,
        target: { ...target },
        value: this.value(id),
        startedAt: now + index * 12,
        duration: this.reducedMotion ? 100 : 680,
      });
      this.refills.set(id, now + 1100 + index * 35);
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
    ctx.fillStyle = '#030d1b';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${22 * this.camera.zoom}px "Courier New", monospace`;
    ctx.shadowColor = '#81d5ff';
    ctx.shadowBlur = 4;
    const bounds = this.camera.visibleBounds();
    this.visibleCount = 0;
    for (let row = bounds.top; row < bounds.bottom; row++)
      for (let column = bounds.left; column < bounds.right; column++) {
        const id =
            (((row % this.world.rows) + this.world.rows) % this.world.rows) * this.world.columns +
            (((column % this.world.columns) + this.world.columns) % this.world.columns),
          p = this.basePosition(id, now);
        const refill = this.refills.get(id);
        if (refill !== undefined) {
          ctx.globalAlpha = Math.max(0, Math.min(1, (now - refill) / 900));
          if (ctx.globalAlpha === 1) this.refills.delete(id);
        }
        ctx.fillStyle = this.clusterCells.has(id) ? '#9dcbd8' : '#88bacf';
        if (!this.motion?.cluster.cells.includes(id))
          ctx.fillText(String(this.value(id)), p.x, p.y);
        ctx.globalAlpha = 1;
        this.visibleCount++;
      }
    if (this.motion) {
      const progress = this.motion.progress(now);
      if (this.motion.releasedAt !== null && progress === 0) this.motion = null;
      else {
        for (let i = 0; i < this.motion.cluster.cells.length; i++) {
          const id = this.motion.cluster.cells[i],
            p = this.motion.position(
              i,
              this.basePosition(id, now),
              now,
              this.reducedMotion,
              this.camera.zoom,
            );
          ctx.font = `bold ${22 * this.camera.zoom * p.scale}px "Courier New", monospace`;
          ctx.lineWidth = Math.max(0.01, ((p.scale - 1) / 0.06) * 0.65 * this.camera.zoom);
          const intensity = Math.max(0, Math.min(1, (p.scale - 1) / 0.06));
          ctx.fillStyle = `rgb(${157 + intensity * 35}, ${203 + intensity * 24}, ${216 + intensity * 17})`;
          ctx.strokeStyle = ctx.fillStyle;
          if (intensity > 0) ctx.strokeText?.(String(this.value(id)), p.x, p.y);
          ctx.fillText(String(this.value(id)), p.x, p.y);
        }
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
    this.refills.clear();
  }
}
