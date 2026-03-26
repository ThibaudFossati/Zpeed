/**
 * ZPEED — Notification Stack
 * Minimal iOS-style floating notifications, top-center, stackable.
 *
 * Usage:
 *   showNotif('🎵 Titre ajouté')
 *   showNotif({ icon:'🔥', title:'Roast', sub:'Thibaud...', type:'warn', duration:6000 })
 */

(function() {
  let stack;

  function getStack() {
    if (!stack) {
      stack = document.getElementById('notifStack');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'notifStack';
        document.body.appendChild(stack);
      }
    }
    return stack;
  }

  window.showNotif = function(opts) {
    if (typeof opts === 'string') opts = { title: opts };

    const {
      icon     = '',
      title    = '',
      sub      = '',
      type     = '',       // 'success' | 'warn' | 'error' | 'ai' | ''
      duration = 3800,
    } = opts;

    const el = document.createElement('div');
    el.className = 'notif' + (type ? ` notif-${type}` : '');
    el.style.position = 'relative';
    el.style.overflow = 'hidden';

    el.innerHTML = `
      ${icon ? `<div class="notif-icon">${icon}</div>` : ''}
      <div class="notif-body">
        <div class="notif-title">${title}</div>
        ${sub ? `<div class="notif-sub">${sub}</div>` : ''}
      </div>
      <div class="notif-progress" style="width:100%"></div>
    `;

    getStack().prepend(el);

    // Shrink progress bar over duration
    const bar = el.querySelector('.notif-progress');
    if (bar) {
      requestAnimationFrame(() => {
        bar.style.transition = `width ${duration}ms linear`;
        bar.style.width = '0%';
      });
    }

    // Tap to dismiss early
    el.addEventListener('click', () => dismiss(el));

    const timer = setTimeout(() => dismiss(el), duration);
    el._notifTimer = timer;

    // Cap stack at 4
    const items = getStack().querySelectorAll('.notif:not(.leaving)');
    if (items.length > 4) dismiss(items[items.length - 1]);

    return el;
  };

  function dismiss(el) {
    if (!el || el.classList.contains('leaving')) return;
    clearTimeout(el._notifTimer);
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  // Backward compat: keep showToast working everywhere
  window.showToast = function(msg) {
    window.showNotif({ title: msg });
  };
})();
