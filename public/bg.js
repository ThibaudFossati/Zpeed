/**
 * ZPEED — Animated Teal Atmosphere
 * Deep teal cinematic background · cyan light halos · white concert particles
 */
(function () {
  function init() {
  const canvas = document.createElement('canvas');
  canvas.id = 'zpeed-bg';
  canvas.style.cssText = [
    'position:fixed', 'inset:0', 'width:100%', 'height:100%',
    'z-index:0', 'pointer-events:none', 'display:block'
  ].join(';');
  document.body.prepend(canvas);

  const style = document.createElement('style');
  style.textContent = `
    body { background: #050d12 !important; }
    .container, #toast, .modal-overlay {
      position: relative;
      z-index: 1;
    }
    .mini-player {
      z-index: 80;
    }
  `;
  document.head.appendChild(style);

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // ── TEAL/CYAN ORBS ───────────────────────────────────────────
  const orbs = [
    // Bright cyan upper-left (main glow like screenshot)
    {
      x: 0.18, y: 0.22, r: 0.62,
      color: [0, 185, 210], alpha: 0.32,
      px: 0.00, py: 1.10, pr: 2.30,
      sx: 0.000180, sy: 0.000140, sr: 0.000160,
      ax: 0.14, ay: 0.12, ar: 0.08,
      scaleX: 1.40, scaleY: 0.85
    },
    // Deep teal lower-right
    {
      x: 0.78, y: 0.75, r: 0.55,
      color: [0, 155, 175], alpha: 0.24,
      px: 1.60, py: 0.55, pr: 0.80,
      sx: 0.000150, sy: 0.000200, sr: 0.000130,
      ax: 0.12, ay: 0.14, ar: 0.07,
      scaleX: 0.90, scaleY: 1.25
    },
    // Mid cyan center-left
    {
      x: 0.12, y: 0.60, r: 0.45,
      color: [0, 200, 220], alpha: 0.18,
      px: 0.90, py: 2.00, pr: 1.50,
      sx: 0.000170, sy: 0.000120, sr: 0.000150,
      ax: 0.13, ay: 0.11, ar: 0.08,
      scaleX: 1.15, scaleY: 0.80
    },
    // Dark blue-teal right
    {
      x: 0.82, y: 0.30, r: 0.42,
      color: [0, 100, 140], alpha: 0.20,
      px: 2.70, py: 0.30, pr: 3.10,
      sx: 0.000130, sy: 0.000180, sr: 0.000110,
      ax: 0.10, ay: 0.13, ar: 0.06,
      scaleX: 1.00, scaleY: 1.20
    },
    // Deep accent center
    {
      x: 0.50, y: 0.50, r: 0.35,
      color: [0, 80, 110], alpha: 0.12,
      px: 1.80, py: 3.20, pr: 0.60,
      sx: 0.000090, sy: 0.000100, sr: 0.000080,
      ax: 0.07, ay: 0.07, ar: 0.04,
      scaleX: 1.50, scaleY: 0.65
    },
    // Warm teal glimmer top-right
    {
      x: 0.72, y: 0.08, r: 0.30,
      color: [30, 215, 225], alpha: 0.14,
      px: 0.40, py: 1.90, pr: 2.80,
      sx: 0.000240, sy: 0.000165, sr: 0.000200,
      ax: 0.18, ay: 0.09, ar: 0.05,
      scaleX: 1.70, scaleY: 0.55
    },
  ];

  // ── WHITE CONCERT PARTICLES ───────────────────────────────────
  const RNG = (a, b) => Math.random() * (b - a) + a;
  const stars = Array.from({ length: 90 }, () => ({
    x:  RNG(0, 1), y:  RNG(0, 1),
    r:  RNG(0.4, 1.8),
    baseOpacity: RNG(0.06, 0.45),
    twinkleAmp:  RNG(0.3, 0.6),
    twinkleSpd:  RNG(0.00045, 0.0014),
    twinkleOff:  RNG(0, Math.PI * 2),
    driftX:      RNG(-0.025, 0.025),
    driftY:      RNG(-0.018, 0.018),
    driftSpd:    RNG(0.000025, 0.000065),
    driftOff:    RNG(0, Math.PI * 2),
  }));

  // ── WHITE BOKEH BLOBS ─────────────────────────────────────────
  const bokeh = Array.from({ length: 18 }, () => ({
    x:    RNG(0, 1), y:    RNG(0, 1),
    r:    RNG(18, 55),
    alpha: RNG(0.03, 0.10),
    driftSpd: RNG(0.000015, 0.000042),
    driftOff: RNG(0, Math.PI * 2),
    driftAmp: RNG(0.06, 0.14),
  }));

  function drawOrb(o, t) {
    const cx  = (o.x + Math.sin(t * o.sx + o.px) * o.ax) * W;
    const cy  = (o.y + Math.cos(t * o.sy + o.py) * o.ay) * H;
    const scale = 1 + Math.sin(t * o.sr + o.pr) * o.ar;
    const base  = Math.min(W, H);
    const rx    = o.r * base * scale * o.scaleX;
    const ry    = o.r * base * scale * o.scaleY;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.sin(t * 0.000055 + o.px) * 0.4);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    const [R, G, B] = o.color;
    grad.addColorStop(0.00, `rgba(${R},${G},${B},${o.alpha})`);
    grad.addColorStop(0.35, `rgba(${R},${G},${B},${(o.alpha * 0.55).toFixed(3)})`);
    grad.addColorStop(0.70, `rgba(${R},${G},${B},${(o.alpha * 0.18).toFixed(3)})`);
    grad.addColorStop(1.00, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBokeh(t) {
    bokeh.forEach(b => {
      const x = (b.x + Math.sin(t * b.driftSpd + b.driftOff) * b.driftAmp) * W;
      const y = (b.y + Math.cos(t * b.driftSpd * 0.7 + b.driftOff) * b.driftAmp * 0.7) * H;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, b.r);
      grad.addColorStop(0,   `rgba(255,255,255,${b.alpha})`);
      grad.addColorStop(0.4, `rgba(255,255,255,${(b.alpha * 0.35).toFixed(3)})`);
      grad.addColorStop(1,   `rgba(255,255,255,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawStars(t) {
    stars.forEach(s => {
      const x = (s.x + Math.sin(t * s.driftSpd + s.driftOff) * s.driftX) * W;
      const y = (s.y + Math.cos(t * s.driftSpd * 0.8 + s.driftOff) * s.driftY) * H;
      const twinkle = 0.5 + 0.5 * Math.sin(t * s.twinkleSpd + s.twinkleOff);
      const opacity = s.baseOpacity * (1 - s.twinkleAmp + s.twinkleAmp * twinkle);
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${opacity.toFixed(3)})`;
      ctx.fill();
    });
  }

  function render(t) {
    ctx.fillStyle = '#050d12';
    ctx.fillRect(0, 0, W, H);
    orbs.forEach(o => drawOrb(o, t));
    drawBokeh(t);
    drawStars(t);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
  }
  if (document.body) { init(); }
  else { document.addEventListener('DOMContentLoaded', init); }
})();
