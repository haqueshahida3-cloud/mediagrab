// MediaGrab shared core: helpers, i18n, formatting, API, toasts, modal, theme engine, page chrome.
import { STRINGS } from './i18n.js';
import { EXTRA } from './i18n-v2.js';
import { icon, brandIcon, hydrateIcons, PLATFORM_META } from './icons.js';

for (const l of Object.keys(EXTRA)) Object.assign(STRINGS[l] || (STRINGS[l] = {}), EXTRA[l]);
export { STRINGS, icon, brandIcon, hydrateIcons, PLATFORM_META };

/* ------------------------------------------------------------------ helpers */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const truncate = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

export const store = {
  get(k, d) { try { const v = localStorage.getItem('mg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mg.' + k, JSON.stringify(v)); } catch { /* quota */ } },
  raw(k, v) { try { if (v === undefined) return localStorage.getItem('mg.' + k); if (v === null) return localStorage.removeItem('mg.' + k); localStorage.setItem('mg.' + k, v); } catch { return null; } },
};

export const ui = {
  lang: STRINGS[document.documentElement.lang] ? document.documentElement.lang : 'en',
  spa: false,
  installPrompt: null,
  langListeners: [],
  themeListeners: [],
};

/* ------------------------------------------------------------------ i18n & formatting */
export function t(key, vars) {
  const dict = STRINGS[ui.lang] || STRINGS.en;
  let s = dict[key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
export const locale = () => (ui.lang === 'bn' ? 'bn-BD' : 'en-US');
export const bnDigits = (s) => String(s).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);
export const localDigits = (s) => (ui.lang === 'bn' ? bnDigits(s) : String(s));
export const fmtNum = (n) => new Intl.NumberFormat(locale()).format(n);
export const fmtCompact = (n) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export function fmtBytes(b) {
  if (!b || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: i >= 2 && b < 100 ? 1 : 0 }).format(b) + ' ' + u[i];
}
export function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const mb = bps / (1024 * 1024);
  return mb >= 1 ? `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(mb)} MB/s` : `${fmtBytes(bps)}/s`;
}
export function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const str = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return localDigits(str);
}
export function fmtDate(iso) {
  try { return new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return iso; }
}
export function timeAgo(ts) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const diff = (ts - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), u);
  return rtf.format(Math.round(diff), 'second');
}
export function applyI18n(root = document) {
  $$('[data-i18n]', root).forEach((el) => { const v = t(el.dataset.i18n); if (v !== el.dataset.i18n) el.textContent = v; });
  $$('[data-i18n-html]', root).forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$('[data-i18n-placeholder]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $$('[data-i18n-label]', root).forEach((el) => { el.label = t(el.dataset.i18nLabel); });
}
export function setLang(lang) {
  lang = STRINGS[lang] ? lang : 'en';
  store.raw('lang', lang);
  document.cookie = `mg_lang=${lang};path=/;max-age=31536000;samesite=lax`;
  if (!ui.spa) {  // server-rendered pages: reload in the other language
    const u = new URL(location.href);
    if (lang === 'bn') u.searchParams.set('lang', 'bn'); else u.searchParams.delete('lang');
    location.href = u.toString();
    return;
  }
  ui.lang = lang;
  document.documentElement.lang = lang;
  const lb = $('#langLabel');
  if (lb) lb.textContent = lang === 'bn' ? 'English' : 'বাংলা';
  const u = new URL(location.href);
  if (lang === 'bn') u.searchParams.set('lang', 'bn'); else u.searchParams.delete('lang');
  history.replaceState(history.state, '', u.toString());
  applyI18n();
  renderThemeMenu();
  ui.langListeners.forEach((cb) => cb(lang));
}
export const onLang = (cb) => ui.langListeners.push(cb);

/* ------------------------------------------------------------------ URL helpers */
export const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  facebook: ['facebook.com', 'fb.watch', 'fb.com', 'fb.me'],
  instagram: ['instagram.com', 'instagr.am'],
  twitter: ['twitter.com', 'x.com', 't.co'],
  tiktok: ['tiktok.com'],
  vimeo: ['vimeo.com'], reddit: ['reddit.com', 'redd.it'], dailymotion: ['dailymotion.com', 'dai.ly'],
  soundcloud: ['soundcloud.com'], pinterest: ['pinterest.com', 'pin.it'], threads: ['threads.net', 'threads.com'],
  twitch: ['twitch.tv'], linkedin: ['linkedin.com'], snapchat: ['snapchat.com'], bilibili: ['bilibili.com', 'bilibili.tv', 'b23.tv'],
};
export function extractUrl(text) {
  const s = String(text || '').trim();
  const m = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (m) return m[0].replace(/[.,;:!?)\]}>]+$/, '');
  if (/^(www\.)?[\w-]+(\.[\w-]+)+\/\S*$/i.test(s)) return 'https://' + s;
  return null;
}
export function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    for (const [p, hosts] of Object.entries(PLATFORM_HOSTS)) if (hosts.some((x) => h === x || h.endsWith('.' + x))) return p;
    return 'other';
  } catch { return null; }
}
export const pname = (p) => (PLATFORM_META[p] || PLATFORM_META.other).name;

/* ------------------------------------------------------------------ API */
export async function api(path, { method = 'GET', body, raw = false, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, signal,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(navigator.onLine === false ? t('err.offline') : t('tip.network'));
    err.code = 'network';
    throw err;
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || t('err.server', { s: res.status }));
    err.code = (data && data.code) || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Upload a File with progress (XHR gives upload progress events, fetch doesn't). */
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tools/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else { const err = new Error((data && data.error) || t('err.server', { s: xhr.status })); err.code = data?.code; reject(err); }
    };
    xhr.onerror = () => reject(Object.assign(new Error(t('tip.network')), { code: 'network' }));
    xhr.send(file);
  });
}

/** Submit a job and wait until it reaches a final state (used by Media Tools). */
export async function runJob(body, { endpoint = '/api/download', onUpdate, signal } = {}) {
  let job = await api(endpoint, { method: 'POST', body });
  onUpdate?.(job);
  while (['queued', 'preparing', 'downloading', 'processing'].includes(job.status)) {
    if (signal?.aborted) { api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}); throw new DOMException('aborted', 'AbortError'); }
    await sleep(document.hidden ? 2500 : 900);
    job = await api(`/api/jobs/${job.id}`);
    onUpdate?.(job);
  }
  if (job.status !== 'finished') { const e = new Error(job.error || t('stage.error')); e.code = job.error_code; throw e; }
  return job;
}

export function saveUrl(url, filename = '') {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  saveUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/* ------------------------------------------------------------------ toasts */
export function toast(msg, type = 'info', { action, onAction, timeout = 4200 } = {}) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  const ic = type === 'ok' ? 'check-circle' : type === 'err' ? 'alert' : 'info';
  el.innerHTML = `<span class="ti">${icon(ic)}</span><span>${esc(msg)}</span>${action ? `<button class="ta">${esc(action)}</button>` : ''}`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  if (action) el.querySelector('.ta').addEventListener('click', () => { onAction?.(); close(); });
  wrap.appendChild(el);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
  setTimeout(close, timeout);
}

/* ------------------------------------------------------------------ modal */
let modalKeyHandler = null;
export function openModal(title, html, { wide = false, onKey } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box ${wide ? 'wide' : ''}"><div class="modal-head"><b>${esc(title)}</b><button class="icon-btn" id="modalClose" aria-label="Close">${icon('x')}</button></div><div class="modal-media modal-body">${html}</div></div>`;
  m.classList.remove('hidden');
  $('#modalClose').onclick = closeModal;
  modalKeyHandler = onKey || null;
  setTimeout(() => $('#modalClose')?.focus(), 30);
}
export function closeModal() {
  const m = $('#modal');
  if (!m) return;
  m.querySelectorAll('video,audio').forEach((v) => v.pause());
  m.innerHTML = '';
  m.classList.add('hidden');
  modalKeyHandler = null;
}
export const modalOpen = () => !$('#modal')?.classList.contains('hidden');

/* ------------------------------------------------------------------ theme engine */
export const THEMES = ['system', 'light', 'dark', 'amoled', 'gray'];
export const ACCENTS = {
  sunset: ['#8b5cf6', '#d946ef', '#f97316'], ocean: ['#3b82f6', '#06b6d4', '#22d3ee'], emerald: ['#10b981', '#22c55e', '#84cc16'],
  rose: ['#f43f5e', '#ec4899', '#fb7185'], amber: ['#f59e0b', '#f97316', '#ef4444'], indigo: ['#6366f1', '#8b5cf6', '#a855f7'],
  mono: ['#64748b', '#94a3b8', '#cbd5e1'],
};
export const BACKGROUNDS = ['aurora', 'mesh', 'grid', 'solid', 'image'];
const THEME_COLORS = { light: '#f7f6fc', dark: '#0b0a14', amoled: '#000000', gray: '#1c1c1f' };
const media = window.matchMedia('(prefers-color-scheme: light)');

export const themePref = () => store.raw('theme') || 'system';
export const effectiveTheme = (pref = themePref()) => (pref === 'system' ? (media.matches ? 'light' : 'dark') : pref);

export function setTheme(pref) {
  if (!THEMES.includes(pref)) pref = 'system';
  store.raw('theme', pref);
  const eff = effectiveTheme(pref);
  const d = document.documentElement;
  d.dataset.theme = eff;
  d.dataset.themePref = pref;
  $('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[eff] || '#0b0a14');
  renderThemeMenu();
  ui.themeListeners.forEach((cb) => cb(pref));
}
export function cycleTheme() {
  const i = THEMES.indexOf(themePref());
  setTheme(THEMES[(i + 1) % THEMES.length]);
  toast(`${t('theme.mode')}: ${t('theme.' + themePref())}`, 'info', { timeout: 1600 });
}
media.addEventListener?.('change', () => { if (themePref() === 'system') setTheme('system'); });

function hexToHsl(hex) {
  const m = hex.replace('#', '').match(/.{2}/g).map((x) => parseInt(x, 16) / 255);
  const [r, g, b] = m; const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
export const accentKey = () => store.raw('accentKey') || 'sunset';
export function setAccent(keyOrHex) {
  let colors;
  if (ACCENTS[keyOrHex]) { colors = ACCENTS[keyOrHex]; store.raw('accentKey', keyOrHex); }
  else if (/^#[0-9a-f]{6}$/i.test(keyOrHex)) {
    const [h, s, l] = hexToHsl(keyOrHex);
    colors = [keyOrHex, hsl(h + 32, Math.min(95, s + 5), Math.min(62, Math.max(48, l))), hsl(h + 64, Math.min(95, s + 8), Math.min(66, Math.max(50, l + 4)))];
    store.raw('accentKey', 'custom'); store.raw('accentCustom', keyOrHex);
  } else return;
  store.raw('accent', JSON.stringify(colors));
  const d = document.documentElement.style;
  d.setProperty('--a1', colors[0]); d.setProperty('--a2', colors[1]); d.setProperty('--a3', colors[2]);
}
export const bgPref = () => store.raw('bg') || 'aurora';
export async function setBg(key) {
  if (!BACKGROUNDS.includes(key)) key = 'aurora';
  store.raw('bg', key);
  document.documentElement.dataset.bg = key;
  if (key === 'image') await loadBgImage();
}
export const motionReduced = () => document.documentElement.dataset.motion === 'reduce';
export function setMotion(reduce) {
  store.raw('motion', reduce ? 'reduce' : 'full');
  if (reduce) document.documentElement.dataset.motion = 'reduce'; else delete document.documentElement.dataset.motion;
}

// custom background image lives in IndexedDB (too big for localStorage)
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mediagrab', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const r = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
let bgUrl = null;
export async function loadBgImage() {
  try {
    const blob = await idbOp('readonly', (s) => s.get('bgImage'));
    const el = $('#bgImage');
    if (!el) return;
    if (bgUrl) URL.revokeObjectURL(bgUrl);
    bgUrl = blob ? URL.createObjectURL(blob) : null;
    el.style.backgroundImage = bgUrl ? `url("${bgUrl}")` : '';
  } catch { /* IndexedDB unavailable */ }
}
export async function setBgImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  // downscale big photos so the background stays light
  const bmp = await createImageBitmap(file).catch(() => null);
  let blob = file;
  if (bmp && (bmp.width > 2200 || file.size > 1.5e6)) {
    const scale = Math.min(1, 2200 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)) || file;
  }
  await idbOp('readwrite', (s) => s.put(blob, 'bgImage'));
  await setBg('image');
  toast(t('bg.imageSet'), 'ok');
}

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon', amoled: 'moon', gray: 'palette' };
export function renderThemeMenu() {
  const menu = $('#themeMenu');
  if (!menu) return;
  const pref = themePref();
  const ak = accentKey();
  menu.innerHTML = `
    <div class="label">${esc(t('theme.mode'))}</div>
    ${THEMES.map((k) => `<button type="button" role="menuitemradio" aria-checked="${k === pref}" class="${k === pref ? 'on' : ''}" data-theme-set="${k}">${icon(THEME_ICON[k])}${esc(t('theme.' + k))}</button>`).join('')}
    <div class="sep"></div>
    <div class="label">${esc(t('theme.accent'))}</div>
    <div class="swatches" style="padding:6px 10px 8px">
      ${Object.entries(ACCENTS).map(([k, c]) => `<button type="button" class="swatch ${k === ak ? 'on' : ''}" title="${esc(t('acc.' + k))}" aria-label="${esc(t('acc.' + k))}" data-accent="${k}" style="background:linear-gradient(135deg,${c[0]},${c[1]},${c[2]})"></button>`).join('')}
      <label class="swatch custom ${ak === 'custom' ? 'on' : ''}" title="${esc(t('theme.custom'))}"><input type="color" value="${esc(store.raw('accentCustom') || '#8b5cf6')}" data-accent-custom aria-label="${esc(t('theme.custom'))}"></label>
    </div>
    <div class="sep"></div>
    <div class="label">${esc(t('theme.bg'))}</div>
    ${BACKGROUNDS.map((k) => `<button type="button" class="${k === bgPref() ? 'on' : ''}" data-bg-set="${k}">${esc(t('bg.' + k))}</button>`).join('')}
    <input type="file" accept="image/*" id="bgFile" hidden>`;
  const icn = $('#themeIcon');
  if (icn) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icon(THEME_ICON[pref] || 'palette');
    const svg = tpl.content.firstElementChild; svg.id = 'themeIcon'; icn.replaceWith(svg);
  }
}

function bindThemeMenu() {
  const btn = $('#themeBtn'), menu = $('#themeMenu');
  if (!btn || !menu) return;
  const close = () => { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.contains('hidden');
    if (open) { renderThemeMenu(); menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); } else close();
  });
  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const th = e.target.closest('[data-theme-set]');
    const ac = e.target.closest('[data-accent]');
    const bg = e.target.closest('[data-bg-set]');
    if (th) setTheme(th.dataset.themeSet);
    if (ac) { setAccent(ac.dataset.accent); renderThemeMenu(); }
    if (bg) {
      if (bg.dataset.bgSet === 'image') { $('#bgFile').click(); return; }
      await setBg(bg.dataset.bgSet); renderThemeMenu();
    }
  });
  menu.addEventListener('input', (e) => { if (e.target.matches('[data-accent-custom]')) setAccent(e.target.value); });
  menu.addEventListener('change', async (e) => {
    if (e.target.matches('[data-accent-custom]')) renderThemeMenu();
    if (e.target.id === 'bgFile' && e.target.files[0]) { await setBgImage(e.target.files[0]); renderThemeMenu(); }
  });
  document.addEventListener('click', close);
}

/* ------------------------------------------------------------------ shortcuts help */
export const SHORTCUTS = [
  [['/'], 'kb.focus'], [['Ctrl', 'V'], 'kb.paste'], [['D'], 'kb.downloads'], [['H'], 'kb.history'], [['S'], 'kb.settings'],
  [['T'], 'kb.theme'], [['L'], 'kb.lang'], [['M'], 'kb.tools'], [['←', '→'], 'kb.gallery'], [['A'], 'kb.selectAll'], [['?'], 'kb.help'], [['Esc'], 'kb.close'],
];
export function showShortcuts() {
  openModal(t('kb.title'), `<div class="kbd-list">${SHORTCUTS.map(([keys, k]) => `<div><span>${esc(t(k))}</span><span>${keys.map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span></div>`).join('')}</div>`);
}
const typing = (e) => !!e.target.closest?.('input, textarea, select, [contenteditable="true"]');

/* ------------------------------------------------------------------ PWA */
function setupPWA() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast(t('pwa.update'), 'info', { action: t('pwa.reload'), onAction: () => location.reload(), timeout: 12000 });
          }
        });
      });
    }).catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
    $('#installBtn')?.classList.remove('hidden');
  });
  const install = async () => {
    if (ui.installPrompt) {
      ui.installPrompt.prompt();
      await ui.installPrompt.userChoice.catch(() => {});
      ui.installPrompt = null;
      $('#installBtn')?.classList.add('hidden');
    } else {
      toast(/iphone|ipad|ipod/i.test(navigator.userAgent) ? t('pwa.ios') : t('pwa.manual'), 'info', { timeout: 7000 });
    }
  };
  $('#installBtn')?.addEventListener('click', install);
  $('#installBtn2')?.addEventListener('click', install);
  window.addEventListener('appinstalled', () => toast(t('pwa.done'), 'ok'));
}

/* ------------------------------------------------------------------ page chrome */
export function initChrome({ spa = false, onKey } = {}) {
  ui.spa = spa;
  // broken remote thumbnails just disappear (CSP forbids inline onerror handlers)
  document.addEventListener('error', (e) => { if (e.target?.tagName === 'IMG' && e.target.hasAttribute('data-fallback')) e.target.remove(); }, true);
  hydrateIcons();
  bindThemeMenu();
  renderThemeMenu();
  if (bgPref() === 'image') loadBgImage();

  $('#langBtn')?.addEventListener('click', () => setLang(ui.lang === 'bn' ? 'en' : 'bn'));

  const mm = $('#mobileMenu'), mb = $('#menuBtn');
  const setMenu = (open) => { mm?.classList.toggle('open', open); mm?.setAttribute('aria-hidden', String(!open)); mb?.setAttribute('aria-expanded', String(open)); };
  mb?.addEventListener('click', () => setMenu(true));
  $$('[data-close-menu]').forEach((el) => el.addEventListener('click', () => setMenu(false)));
  // close "More" dropdowns when clicking elsewhere
  document.addEventListener('click', (e) => { $$('details.nav-more[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); }); });
  $('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); setMenu(false); $('#themeMenu')?.classList.add('hidden'); }
    if (modalOpen() && modalKeyHandler && modalKeyHandler(e)) return;
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (onKey && onKey(e)) return;
    const k = e.key.toLowerCase();
    if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if (k === 't') cycleTheme();
    else if (k === 'l') setLang(ui.lang === 'bn' ? 'en' : 'bn');
    else if (k === 'm' && location.pathname !== '/tools') location.href = '/tools';
  });
  setupPWA();
}
