/**
 * ZPEED — Premium Logo Animation
 * Z deploys into ZPEED with cinematic speed effect
 * Inspired by premium side-navigation glassmorphism
 */
(function () {
  // Create container for animation
  const container = document.createElement('div');
  container.id = 'zpeed-logo-anim';
  container.style.cssText = `
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    background: rgba(8, 8, 15, 0.85);
    backdrop-filter: blur(20px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.4s ease-out;
  `;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  container.appendChild(canvas);
  document.body.appendChild(container);

  // ── ANIMATION STATE ──────────────────────────────────────────
  const state = {
    progress: 0,          // 0 to 1
    isPlaying: false,
    startTime: 0,
    duration: 2800,       // 2.8 seconds
  };

  // ── COLORS ───────────────────────────────────────────────────
  const colors = {
    accent: '#00d4c8',
    accentLight: '#33ddd8',
    text: '#EBEBF5',
    glow: 'rgba(0, 212, 200, 0.6)',
  };

  // ── DRAW FUNCTIONS ────────────────────────────────────────────
  function drawZ(x, y, size, progress, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity;

    // Z shape - simple diagonal + horizontals
    const w = size * 0.6;
    const h = size * 1.2;

    ctx.strokeStyle = colors.accentLight;
    ctx.lineWidth = Math.max(2, size * 0.15);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Top horizontal (deploys from right)
    ctx.beginPath();
    ctx.moveTo(x - w * progress, y - h / 2);
    ctx.lineTo(x + w, y - h / 2);
    ctx.stroke();

    // Diagonal (deploys from top-right to bottom-left)
    const diagProgress = Math.max(0, progress - 0.2);
    ctx.beginPath();
    ctx.moveTo(x + w - (w + w) * diagProgress, y - h / 2);
    ctx.lineTo(x - w + (w * 2) * diagProgress, y + h / 2);
    ctx.stroke();

    // Bottom horizontal (deploys from left)
    const bottomProg = Math.max(0, progress - 0.4);
    ctx.beginPath();
    ctx.moveTo(x - w, y + h / 2);
    ctx.lineTo(x + w - (w * 2) * bottomProg, y + h / 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawText(x, y, text, size, progress, opacity, delay = 0) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, opacity - delay);

    ctx.font = `bold ${size}px 'Inter', sans-serif`;
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Scale in effect
    const scaleProgress = Math.max(0, (progress - delay) / (1 - delay));
    ctx.transform(1, 0, 0, 1, x, y);
    ctx.scale(scaleProgress * 0.8 + 0.2, scaleProgress * 0.8 + 0.2);
    ctx.translate(-x, -y);

    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawSpeedLines(progress) {
    ctx.save();
    const lineOpacity = Math.sin(progress * Math.PI) * 0.3;
    ctx.globalAlpha = lineOpacity;
    ctx.strokeStyle = colors.glow;
    ctx.lineWidth = 2;

    const baseX = canvas.width / 2;
    const baseY = canvas.height / 2;
    const count = 8;
    const maxDist = 200;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const distFrom = maxDist * 0.3 * progress;
      const distTo = maxDist * (0.5 + progress * 0.5);

      ctx.beginPath();
      ctx.moveTo(
        baseX + Math.cos(angle) * distFrom,
        baseY + Math.sin(angle) * distFrom
      );
      ctx.lineTo(
        baseX + Math.cos(angle) * distTo,
        baseY + Math.sin(angle) * distTo
      );
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawGlowBg(progress) {
    ctx.save();
    const size = 250 + progress * 100;
    const opacity = Math.sin(progress * Math.PI) * 0.08;

    const grad = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, size * 0.3,
      canvas.width / 2, canvas.height / 2, size
    );
    grad.addColorStop(0, `rgba(0, 212, 200, ${opacity})`);
    grad.addColorStop(0.5, `rgba(51, 221, 216, ${opacity * 0.5})`);
    grad.addColorStop(1, 'rgba(0, 212, 200, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function render(now) {
    if (!state.isPlaying) return;

    const elapsed = now - state.startTime;
    state.progress = Math.min(1, elapsed / state.duration);

    // Clear
    ctx.fillStyle = 'rgba(8, 8, 15, 0)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Phases
    const zPhase = Math.min(1, state.progress / 0.4);              // 0-0.4
    const expandPhase = Math.min(1, (state.progress - 0.2) / 0.6); // 0.2-0.8
    const textPhase = Math.min(1, (state.progress - 0.4) / 0.4);   // 0.4-0.8
    const finalPhase = Math.max(0, state.progress - 0.8);          // 0.8-1.0

    drawGlowBg(state.progress);
    drawSpeedLines(expandPhase);

    // Draw Z that deploys
    drawZ(cx - 120, cy, 60, zPhase, 1);

    // Draw ZPEED text that scales in
    if (expandPhase > 0.1) {
      drawText(cx + 80, cy, 'ZPEED', 54, expandPhase, 1, 0.15);
    }

    // Fade out at end
    if (finalPhase > 0) {
      ctx.globalAlpha = 1 - finalPhase;
      ctx.fillStyle = 'rgba(8, 8, 15, 1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (state.progress < 1) {
      requestAnimationFrame(render);
    } else {
      state.isPlaying = false;
      container.style.opacity = '0';
      setTimeout(() => {
        container.style.pointerEvents = 'none';
      }, 400);
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────────
  window.playZpeedLogoAnimation = function() {
    state.progress = 0;
    state.isPlaying = true;
    state.startTime = performance.now();
    container.style.opacity = '1';
    container.style.pointerEvents = 'all';
    requestAnimationFrame(render);
  };

  // Auto-play on first page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => window.playZpeedLogoAnimation(), 300);
    });
  } else {
    setTimeout(() => window.playZpeedLogoAnimation(), 300);
  }
})();
