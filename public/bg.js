/**
 * ZPEED — Adaptive Ambient Background
 * Follows system theme automatically (prefers-color-scheme).
 */
(function () {
  function init() {
    const canvas = document.createElement('canvas');
    canvas.id = 'zpeed-bg';
    canvas.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'z-index:0',
      'pointer-events:none',
      'display:block',
    ].join(';');
    document.body.prepend(canvas);

    const style = document.createElement('style');
    document.head.appendChild(style);

    const ctx = canvas.getContext('2d');
    let width = 0;
    let height = 0;

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // ZPEED is always dark — no light theme
    let theme = null;

    const darkTheme = {
      bg: '#0d0d15',
      dustColor: [220, 235, 255],
      mists: [
        // Blue — upper left
        {
          x: 0.12, y: 0.14, r: 0.60,
          color: [59, 130, 246], alpha: 0.18,
          px: 0.3, py: 1.1, pr: 1.9,
          sx: 0.00015, sy: 0.00012, sr: 0.0001,
          ax: 0.10, ay: 0.10, ar: 0.08, scaleX: 1.45, scaleY: 0.85,
        },
        // Purple — right side
        {
          x: 0.84, y: 0.38, r: 0.46,
          color: [139, 92, 246], alpha: 0.15,
          px: 1.6, py: 0.5, pr: 2.3,
          sx: 0.00011, sy: 0.00014, sr: 0.00008,
          ax: 0.09, ay: 0.09, ar: 0.07, scaleX: 1.15, scaleY: 1.25,
        },
        // Teal — lower center
        {
          x: 0.50, y: 0.88, r: 0.44,
          color: [0, 212, 200], alpha: 0.10,
          px: 0.9, py: 2.2, pr: 0.7,
          sx: 0.00009, sy: 0.00012, sr: 0.00007,
          ax: 0.08, ay: 0.07, ar: 0.06, scaleX: 1.30, scaleY: 0.70,
        },
        // Deep blue — center subtle
        {
          x: 0.44, y: 0.52, r: 0.36,
          color: [96, 165, 250], alpha: 0.05,
          px: 2.4, py: 1.3, pr: 2.8,
          sx: 0.00008, sy: 0.0001, sr: 0.00006,
          ax: 0.05, ay: 0.05, ar: 0.04, scaleX: 1.5, scaleY: 0.74,
        },
      ],
    };

    function applyTheme() {
      theme = darkTheme;
      style.textContent = `
        body { background: ${theme.bg} !important; }
        .container, #toast, .modal-overlay { position: relative; z-index: 1; }
        .mini-player { z-index: 80; }
      `;
    }
    applyTheme();

    const rng = (a, b) => Math.random() * (b - a) + a;
    const dust = Array.from({ length: 72 }, () => ({
      x: rng(0, 1),
      y: rng(0, 1),
      r: rng(0.4, 1.4),
      baseOpacity: rng(0.04, 0.15),
      twinkleAmp: rng(0.18, 0.42),
      twinkleSpeed: rng(0.00045, 0.0012),
      twinkleOffset: rng(0, Math.PI * 2),
      driftX: rng(-0.016, 0.016),
      driftY: rng(-0.015, 0.015),
      driftSpeed: rng(0.00002, 0.00006),
      driftOffset: rng(0, Math.PI * 2),
    }));

    function drawMist(mist, time) {
      const x = (mist.x + Math.sin(time * mist.sx + mist.px) * mist.ax) * width;
      const y = (mist.y + Math.cos(time * mist.sy + mist.py) * mist.ay) * height;
      const base = Math.min(width, height);
      const scale = 1 + Math.sin(time * mist.sr + mist.pr) * mist.ar;
      const rx = mist.r * base * scale * mist.scaleX;
      const ry = mist.r * base * scale * mist.scaleY;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(time * 0.00005 + mist.py) * 0.25);
      ctx.scale(1, ry / rx);

      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      const [r, g, b] = mist.color;
      grad.addColorStop(0, `rgba(${r},${g},${b},${mist.alpha})`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},${(mist.alpha * 0.44).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawDust(time) {
      const [r, g, b] = theme.dustColor;
      dust.forEach((dot) => {
        const x = (dot.x + Math.sin(time * dot.driftSpeed + dot.driftOffset) * dot.driftX) * width;
        const y = (dot.y + Math.cos(time * dot.driftSpeed * 0.84 + dot.driftOffset) * dot.driftY) * height;
        const twinkle = 0.5 + 0.5 * Math.sin(time * dot.twinkleSpeed + dot.twinkleOffset);
        const opacity = dot.baseOpacity * (1 - dot.twinkleAmp + dot.twinkleAmp * twinkle);
        ctx.beginPath();
        ctx.arc(x, y, dot.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${opacity.toFixed(3)})`;
        ctx.fill();
      });
    }

    function render(time) {
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, width, height);
      theme.mists.forEach((mist) => drawMist(mist, time));
      drawDust(time);
      requestAnimationFrame(render);
    }

    requestAnimationFrame(render);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
