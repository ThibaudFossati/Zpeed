const slides = Array.from(document.querySelectorAll('.slide'));
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const currentSlideEl = document.getElementById('current-slide');
const totalSlideEl = document.getElementById('total-slide');
const progressBar = document.getElementById('progress-bar');

let index = 0;

totalSlideEl.textContent = String(slides.length).padStart(2, '0');

function setSlide(nextIndex) {
  index = (nextIndex + slides.length) % slides.length;
  slides.forEach((slide, i) => {
    slide.classList.toggle('active', i === index);
  });

  currentSlideEl.textContent = String(index + 1).padStart(2, '0');
  const progress = ((index + 1) / slides.length) * 100;
  progressBar.style.width = `${progress}%`;
}

function forward() {
  setSlide(index + 1);
}

function backward() {
  setSlide(index - 1);
}

nextBtn.addEventListener('click', forward);
prevBtn.addEventListener('click', backward);

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
    event.preventDefault();
    forward();
  }

  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    backward();
  }
});

let startX = null;

window.addEventListener('touchstart', (event) => {
  startX = event.touches[0].clientX;
}, { passive: true });

window.addEventListener('touchend', (event) => {
  if (startX === null) return;

  const endX = event.changedTouches[0].clientX;
  const delta = endX - startX;

  if (Math.abs(delta) > 45) {
    if (delta < 0) {
      forward();
    } else {
      backward();
    }
  }

  startX = null;
}, { passive: true });

setSlide(0);
