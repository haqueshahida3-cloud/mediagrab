// MediaGrab Button Effects: adds the fx-* classes from button-effects.css to the site's buttons and drives the
// effects that need a little JavaScript (magnetic pull, ripple, elastic press, bounce on tap, icon morph).
// Pure front-end: no network, no tracking. Respects "reduce motion" (OS setting and the site's own switch).
import { ui } from './core.js';
import { icon } from './icons.js';

const KEY = 'mg-fx';
const root = document.documentElement;
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const mqFine = window.matchMedia('(hover: hover) and (pointer: fine)');

const reduced = () => mqReduce.matches || root.dataset.motion === 'reduce';
const wanted = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
const active = () => root.classList.contains('mgfx');
const sync = () => root.classList.toggle('mgfx', wanted() && !reduced());

/* ------------------------------------------------------------------ which buttons get which effects */
const MAP = [
  ['.btn-primary:not(.btn-dl)', 'magnetic ripple elastic press shimmer arrow'],
  ['#fetchBtn, .dl-go, #ctaStart, #batchBtn, .cta-band .btn-primary', 'gradient glow'],  // main call-to-action buttons only
  ['.btn-secondary, .btn-ghost', 'slide magnetic ripple elastic press arrow'],
  ['.btn-dl', 'ripple press'],
  ['.chip-btn', 'liquid bounce ripple'],
  ['.icon-btn', 'bounce'],
  ['[data-copy]', 'morph'],
  ['.f-link', 'arrow'],
];
const ARROW = '12 5 19 12 12 19';  // points of the arrow-right icon

function markArrows(el) {
  el.querySelectorAll('svg').forEach((svg) => { if (svg.innerHTML.includes(ARROW)) svg.classList.add('mgfx-arrow-ic'); });
}

function decorate(scope) {
  for (const [selector, effects] of MAP) {
    const list = [...scope.querySelectorAll(selector)];
    if (scope.matches?.(selector)) list.push(scope);
    for (const el of list) {
      el.classList.add('fxb', ...effects.split(' ').map((n) => `fx-${n}`));
      if (effects.includes('arrow')) markArrows(el);
    }
  }
}

/* ------------------------------------------------------------------ 1. magnetic */
let magnet = null;
let magnetEvent = null;
let frame = 0;
const release = (el) => { if (el) { el.style.removeProperty('--mx'); el.style.removeProperty('--my'); } };
const clamp = (n) => Math.max(-1, Math.min(1, n));

function pull() {
  frame = 0;
  if (!magnet || !magnetEvent) return;
  const r = magnet.getBoundingClientRect();
  const dx = clamp((magnetEvent.clientX - (r.left + r.width / 2)) / (r.width / 2));
  const dy = clamp((magnetEvent.clientY - (r.top + r.height / 2)) / (r.height / 2));
  magnet.style.setProperty('--mx', `${(dx * 6).toFixed(1)}px`);
  magnet.style.setProperty('--my', `${(dy * 4).toFixed(1)}px`);
}
document.addEventListener('pointermove', (e) => {
  if (!active() || e.pointerType !== 'mouse' || !mqFine.matches) return;
  const el = e.target.closest?.('.fx-magnetic:not([disabled])') || null;
  if (el !== magnet) { release(magnet); magnet = el; }
  if (magnet) { magnetEvent = e; if (!frame) frame = requestAnimationFrame(pull); }
}, { passive: true });
root.addEventListener('pointerleave', () => { release(magnet); magnet = null; });

/* ------------------------------------------------------------------ 2. ripple */
function ripple(el, x, y) {
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const dot = document.createElement('span');
  dot.className = 'mgfx-ripple';
  dot.style.cssText = `width:${size}px;height:${size}px;left:${x - r.left - size / 2}px;top:${y - r.top - size / 2}px`;
  el.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
  setTimeout(() => dot.remove(), 900);  // safety net
}
document.addEventListener('pointerdown', (e) => {
  if (!active() || e.button > 0) return;
  const el = e.target.closest?.('.fx-ripple:not([disabled])');
  if (el) ripple(el, e.clientX, e.clientY);
}, { passive: true });
document.addEventListener('click', (e) => {
  if (!active() || e.detail !== 0) return;  // detail 0 = keyboard activation (Enter / Space): ripple from the centre
  const el = e.target.closest?.('.fx-ripple:not([disabled])');
  if (el) { const r = el.getBoundingClientRect(); ripple(el, r.left + r.width / 2, r.top + r.height / 2); }
}, { passive: true });

/* ------------------------------------------------------------------ 3. elastic (squash while pressed) */
let pressed = null;
document.addEventListener('pointerdown', (e) => {
  if (!active()) return;
  const el = e.target.closest?.('.fx-elastic:not([disabled])');
  if (el) { pressed = el; el.classList.add('is-down'); }
}, { passive: true });
const letGo = () => { if (pressed) { pressed.classList.remove('is-down'); pressed = null; } };
window.addEventListener('pointerup', letGo, { passive: true });
window.addEventListener('pointercancel', letGo, { passive: true });
window.addEventListener('blur', letGo);

/* ------------------------------------------------------------------ 12. bounce on tap */
document.addEventListener('click', (e) => {
  if (!active()) return;
  const el = e.target.closest?.('.fx-bounce:not([disabled])');
  if (!el) return;
  el.classList.remove('is-bounce');
  void el.offsetWidth;  // restart the animation on rapid taps
  el.classList.add('is-bounce');
  el.addEventListener('animationend', () => el.classList.remove('is-bounce'), { once: true });
}, { passive: true });

/* ------------------------------------------------------------------ 10. icon morph (copy → check) */
function morph(btn) {
  const svg = btn.querySelector('svg.i:not(.mgfx-morph-in)');
  if (!svg || btn.dataset.fxBusy) return;
  const extra = (svg.getAttribute('class') || '').replace(/^i\b\s*/, '').replace(/mgfx-arrow-ic/, '').trim();
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(btn.dataset.fxMorph || 'check', extra);
  const next = tpl.content.firstElementChild;
  next.classList.add('mgfx-morph-in');
  btn.dataset.fxBusy = '1';
  svg.replaceWith(next);
  setTimeout(() => {
    if (next.isConnected) next.replaceWith(svg);
    delete btn.dataset.fxBusy;
  }, 1300);
}
document.addEventListener('click', (e) => {
  if (!active()) return;
  const btn = e.target.closest?.('.fx-morph, [data-fx-morph]');
  if (btn) morph(btn);
}, { passive: true });

/* ------------------------------------------------------------------ keep new buttons decorated (queue items, cards) */
const pending = new Set();
let timer = 0;
function flush() {
  timer = 0;
  for (const node of pending) {
    if (!node.isConnected) continue;
    decorate(node);
    const btn = node.closest?.('.fxb');
    if (btn && btn !== node) markArrows(btn);  // icons are swapped in after the page paints
  }
  pending.clear();
}
function watch() {
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) pending.add(n);
    if (pending.size && !timer) timer = setTimeout(flush, 120);
  }).observe(document.body, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------ on / off switch in the UX preferences card */
const TEXT = {
  en: ['Button animations', 'Magnetic, ripple, shimmer, glow and more'],
  bn: ['বাটন অ্যানিমেশন', 'ম্যাগনেটিক, রিপল, শিমার, গ্লো ও আরও অনেক'],
};
function addSwitch() {
  const card = document.getElementById('mg-ux-settings');
  if (!card || card.querySelector('#mgfxToggle')) return !!card;
  const [title, hint] = TEXT[ui.lang] || TEXT.en;
  const row = document.createElement('div');
  row.className = 'mgfx-toggle-row';
  row.innerHTML = '<label class="switch"><input type="checkbox" id="mgfxToggle"><span class="track"></span><span class="mgfx-t"></span></label><small class="muted mgfx-h" style="display:block;margin-top:4px"></small>';
  row.querySelector('.mgfx-t').textContent = title;
  row.querySelector('.mgfx-h').textContent = hint;
  const box = row.querySelector('input');
  box.checked = wanted();
  box.addEventListener('change', () => {
    try { localStorage.setItem(KEY, box.checked ? 'on' : 'off'); } catch { /* private mode */ }
    sync();
  });
  card.appendChild(row);
  return true;
}

/* ------------------------------------------------------------------ start */
sync();
mqReduce.addEventListener?.('change', sync);
new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-motion'] });
decorate(document.body);
watch();
let tries = 0;
const waitCard = setInterval(() => { if (addSwitch() || ++tries > 20) clearInterval(waitCard); }, 400);

// small public hook: MediaGrabFX.disable() / enable(); the same effects work on any element with the fx-* classes
window.MediaGrabFX = {
  enable() { try { localStorage.setItem(KEY, 'on'); } catch { /* ignore */ } sync(); },
  disable() { try { localStorage.setItem(KEY, 'off'); } catch { /* ignore */ } sync(); },
  decorate,
};
