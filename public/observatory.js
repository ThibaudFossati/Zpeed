/**
 * ZPEED Observatory — Spatial node visualization engine
 * Floating nodes with physics, progress rings, glow, real-time hierarchy
 */
(function (window) {
  'use strict';

  // ─── Node ─────────────────────────────────────────────────────────────────
  class ObsNode {
    constructor(id, type, cx, cy) {
      this.id = id;
      this.type = type; // 'playing' | 'track' | 'guest'
      // Start near center
      this.x = cx + (Math.random() - 0.5) * 60;
      this.y = cy + (Math.random() - 0.5) * 60;
      this.vx = (Math.random() - 0.5) * 0.4;
      this.vy = (Math.random() - 0.5) * 0.4;
      this.targetX = cx;
      this.targetY = cy;
      this.size = type === 'playing' ? 160 : type === 'track' ? 72 : 46;
      this.targetSize = this.size;
      this.seed  = Math.random() * Math.PI * 2;
      this.freq  = 0.22 + Math.random() * 0.18;
      this.importance = 1;
      this.progress = 0;
      this.el = null;
      this.color = type === 'playing' ? '#00d4c8'
                 : type === 'track'   ? '#4facfe'
                 :                      '#a78bfa';
    }
  }

  // ─── Observatory ──────────────────────────────────────────────────────────
  class Observatory {
    constructor(containerId) {
      this.wrap = document.getElementById(containerId);
      if (!this.wrap) return;

      // Resize-aware canvas div
      this.canvas = document.createElement('div');
      this.canvas.className = 'obs-canvas';
      this.wrap.appendChild(this.canvas);

      this.nodes = new Map();
      this.w = 0;
      this.h = 0;
      this._raf = null;
      this._progressTimer = null;
      this._progressStart = null;
      this._progressDuration = 0;
      this._emptyEl = this._makeEmpty();
      this.wrap.appendChild(this._emptyEl);

      this._resize();
      const ro = new ResizeObserver(() => { this._resize(); this._arrange(); });
      ro.observe(this.wrap);

      this._loop();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Add or update a node */
    set(id, opts = {}) {
      const { type = 'track', title = '', sub = '', thumb = '', color,
              importance = 1, progress } = opts;
      let node = this.nodes.get(id);
      const cx = this.w / 2, cy = this.h / 2;

      if (!node) {
        node = new ObsNode(id, type, cx, cy);
        node.el = this._mkEl(id, type);
        this.canvas.appendChild(node.el);
        this.nodes.set(id, node);
        requestAnimationFrame(() => node.el.classList.add('obs-node--in'));
      }

      node.type = type;
      node.importance = importance;
      if (color) node.color = color;
      if (progress !== undefined) node.progress = Math.max(0, Math.min(1, progress));

      this._fillEl(node, title, sub, thumb, node.color);
      this._updateRing(node.el, node.progress);
      this._arrange();
      this._hideEmpty();
      return node;
    }

    /** Remove a node */
    del(id) {
      const node = this.nodes.get(id);
      if (!node) return;
      node.el.classList.add('obs-node--out');
      setTimeout(() => {
        node.el?.remove();
        this.nodes.delete(id);
        this._arrange();
        if (this.nodes.size === 0) this._showEmpty();
      }, 520);
    }

    /** Remove all nodes of a given type */
    clear(type) {
      [...this.nodes.keys()].forEach(id => {
        if (!type || this.nodes.get(id)?.type === type) this.del(id);
      });
    }

    /** Update progress ring (0–1) on a node */
    progress(id, val) {
      const node = this.nodes.get(id);
      if (!node) return;
      node.progress = Math.max(0, Math.min(1, val));
      this._updateRing(node.el, node.progress);
    }

    /** Kick off automatic progress over `durationMs` starting now */
    startProgress(id, durationMs) {
      this._stopProgress();
      this._progressId = id;
      this._progressStart = performance.now();
      this._progressDuration = durationMs;
      this._tickProgress();
    }

    _stopProgress() {
      if (this._progressTimer) { clearTimeout(this._progressTimer); this._progressTimer = null; }
      this._progressId = null;
    }

    _tickProgress() {
      if (!this._progressId) return;
      const elapsed = performance.now() - this._progressStart;
      const pct = Math.min(1, elapsed / this._progressDuration);
      this.progress(this._progressId, pct);
      if (pct < 1) this._progressTimer = setTimeout(() => this._tickProgress(), 800);
    }

    /** Pulse glow on a node (votes, interactions) */
    pulse(id) {
      const node = this.nodes.get(id);
      if (!node) return;
      node.el.classList.remove('obs-pulse');
      void node.el.offsetWidth;
      node.el.classList.add('obs-pulse');
    }

    // ── Layout ────────────────────────────────────────────────────────────────

    _arrange() {
      const cx = this.w / 2, cy = this.h / 2;
      const short = Math.min(this.w, this.h);

      const playing = [...this.nodes.values()].filter(n => n.type === 'playing');
      const tracks  = [...this.nodes.values()].filter(n => n.type === 'track')
                        .sort((a, b) => b.importance - a.importance);
      const guests  = [...this.nodes.values()].filter(n => n.type === 'guest')
                        .sort((a, b) => b.importance - a.importance);

      // Playing → center, large
      playing.forEach(n => {
        n.targetX = cx; n.targetY = cy;
        n.targetSize = Math.min(short * 0.36, 170);
      });

      // Tracks → inner ring
      const tR = short * 0.34;
      tracks.forEach((n, i) => {
        const angle = (i / Math.max(tracks.length, 1)) * Math.PI * 2 - Math.PI / 2;
        n.targetX = cx + Math.cos(angle) * tR;
        n.targetY = cy + Math.sin(angle) * tR;
        const imp = Math.max(1, n.importance);
        n.targetSize = Math.max(54, Math.min(96, 54 + imp * 9));
      });

      // Guests → outer ring (staggered so they don't overlap tracks)
      const gR = short * 0.46;
      guests.forEach((n, i) => {
        const phaseShift = tracks.length > 0 ? (Math.PI / guests.length) : 0;
        const angle = (i / Math.max(guests.length, 1)) * Math.PI * 2 + phaseShift - Math.PI / 2;
        n.targetX = cx + Math.cos(angle) * gR;
        n.targetY = cy + Math.sin(angle) * gR;
        const imp = Math.max(1, n.importance);
        n.targetSize = Math.max(38, Math.min(62, 38 + imp * 4));
      });
    }

    // ── Physics loop ──────────────────────────────────────────────────────────

    _loop() {
      const tick = (t) => {
        this.nodes.forEach(node => {
          // Smooth size
          node.size += (node.targetSize - node.size) * 0.07;

          // Spring toward target
          const dx = node.targetX - node.x;
          const dy = node.targetY - node.y;
          node.vx += dx * 0.038;
          node.vy += dy * 0.038;
          node.vx *= 0.80;
          node.vy *= 0.80;
          node.x  += node.vx;
          node.y  += node.vy;

          // Continuous float (sine drift)
          const amp = node.type === 'playing' ? 7 : 12;
          const fx  = Math.sin(t * 0.00055 * node.freq + node.seed) * amp;
          const fy  = Math.cos(t * 0.00042 * node.freq + node.seed * 1.3) * amp;

          const s = node.size;
          node.el.style.width  = s + 'px';
          node.el.style.height = s + 'px';
          node.el.style.transform =
            `translate(${node.x - s / 2 + fx}px, ${node.y - s / 2 + fy}px)`;
          node.el.style.setProperty('--ns', s + 'px');
        });
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────

    _mkEl(id, type) {
      const el = document.createElement('div');
      el.className = `obs-node obs-node--${type}`;
      el.dataset.id = id;
      // SVG circumference for r=44 → 276.46
      el.innerHTML = `
        <div class="obs-glow"></div>
        <svg class="obs-ring" viewBox="0 0 100 100">
          <circle class="obs-ring-bg"       cx="50" cy="50" r="44"/>
          <circle class="obs-ring-progress" cx="50" cy="50" r="44"/>
        </svg>
        <div class="obs-face">
          <img  class="obs-img"   src="" alt="" style="display:none">
          <span class="obs-emoji">🎵</span>
        </div>
        <div class="obs-label">
          <span class="obs-title"></span>
          <span class="obs-sub"></span>
        </div>`;
      return el;
    }

    _fillEl(node, title, sub, thumb, color) {
      const el = node.el;
      const img   = el.querySelector('.obs-img');
      const emoji = el.querySelector('.obs-emoji');
      const t     = el.querySelector('.obs-title');
      const s     = el.querySelector('.obs-sub');
      const glow  = el.querySelector('.obs-glow');

      t.textContent = title || '';
      s.textContent = sub   || '';

      if (thumb) {
        img.src = thumb;
        img.style.display = 'block';
        emoji.style.display = 'none';
      } else {
        img.style.display = 'none';
        emoji.style.display = 'flex';
        emoji.textContent = node.type === 'guest' ? '🎤' : '🎵';
      }

      el.style.setProperty('--nc', color || '#00d4c8');
      // Convert hex → rgba for glow
      const hex = (color || '#00d4c8').replace('#', '');
      const r   = parseInt(hex.slice(0, 2), 16);
      const g   = parseInt(hex.slice(2, 4), 16);
      const b   = parseInt(hex.slice(4, 6), 16);
      if (glow) glow.style.background = `rgba(${r},${g},${b},0.35)`;
    }

    _updateRing(el, progress) {
      const ring = el?.querySelector('.obs-ring-progress');
      if (!ring) return;
      const C = 2 * Math.PI * 44; // ≈ 276.46
      ring.style.strokeDasharray  = C;
      ring.style.strokeDashoffset = C * (1 - progress);
    }

    _resize() {
      this.w = this.wrap.offsetWidth  || 360;
      this.h = this.wrap.offsetHeight || 480;
    }

    _makeEmpty() {
      const el = document.createElement('div');
      el.className = 'obs-empty';
      el.innerHTML = `
        <div class="obs-empty-icon">🎵</div>
        <div class="obs-empty-title">Aucune lecture en cours</div>
        <div class="obs-empty-sub">Les guests proposent · tu valides dans Queue</div>`;
      return el;
    }
    _showEmpty() { this._emptyEl.style.display = 'flex'; }
    _hideEmpty() { this._emptyEl.style.display = 'none'; }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._stopProgress();
      this.canvas.remove();
      this._emptyEl.remove();
    }
  }

  window.Observatory = Observatory;
})(window);
