// MediaGrab front-end — vanilla JS, no build step.
import { STRINGS } from './i18n.js';
import { icon, brandIcon, hydrateIcons, PLATFORM_META } from './icons.js';

/* ------------------------------------------------------------------ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'processing']);
const MAX_PARALLEL = 3;

const store = {
  get(k, d) { try { const v = localStorage.getItem('mg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mg.' + k, JSON.stringify(v)); } catch { /* quota */ } },
  raw(k, v) { try { if (v === undefined) return localStorage.getItem('mg.' + k); localStorage.setItem('mg.' + k, v); } catch { return null; } },
};

const state = {
  lang: STRINGS[document.documentElement.lang] ? document.documentElement.lang : 'en',
  theme: document.documentElement.dataset.theme || 'dark',
  mode: 'single',
  info: null,
  infoUrl: '',
  fetchToken: 0,
  jobs: new Map(),
  jobMeta: store.get('jobs', {}),
  pending: [],
  rowJobs: {},
  plMap: {},
  history: store.get('history', []),
  settings: Object.assign({ autoSave: true, autoFetch: true, notify: false, preferH264: true }, store.get('settings', {})),
  config: null,
  health: null,
  pollTimer: null,
  installPrompt: null,
};

/* ------------------------------------------------------------------ i18n & formatting */
function t(key, vars) {
  const dict = STRINGS[state.lang] || STRINGS.en;
  let s = dict[key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
const locale = () => (state.lang === 'bn' ? 'bn-BD' : 'en-US');
const bnDigits = (s) => String(s).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);
const localDigits = (s) => (state.lang === 'bn' ? bnDigits(s) : String(s));
const fmtNum = (n) => new Intl.NumberFormat(locale()).format(n);
const fmtCompact = (n) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
function fmtBytes(b) {
  if (!b || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: i >= 2 && b < 100 ? 1 : 0 }).format(b) + ' ' + u[i];
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const str = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return localDigits(str);
}
function fmtDate(iso) {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return iso; }
}
function timeAgo(ts) {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const diff = (ts - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), u);
  return rtf.format(Math.round(diff), 'second');
}

/* ------------------------------------------------------------------ URL helpers */
const PLATFORM_HOSTS = {
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  facebook: ['facebook.com', 'fb.watch', 'fb.com', 'fb.me'],
  instagram: ['instagram.com', 'instagr.am'],
  twitter: ['twitter.com', 'x.com', 't.co'],
  tiktok: ['tiktok.com'],
  vimeo: ['vimeo.com'], reddit: ['reddit.com', 'redd.it'], dailymotion: ['dailymotion.com', 'dai.ly'],
  soundcloud: ['soundcloud.com'], pinterest: ['pinterest.com', 'pin.it'], threads: ['threads.net', 'threads.com'],
  twitch: ['twitch.tv'], linkedin: ['linkedin.com'], snapchat: ['snapchat.com'], bilibili: ['bilibili.com', 'bilibili.tv', 'b23.tv'],
};
function extractUrl(text) {
  const s = String(text || '').trim();
  const m = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (m) return m[0].replace(/[.,;:!?)\]}>]+$/, '');
  if (/^(www\.)?[\w-]+(\.[\w-]+)+\/\S*$/i.test(s)) return 'https://' + s;
  return null;
}
function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    for (const [p, hosts] of Object.entries(PLATFORM_HOSTS)) if (hosts.some((x) => h === x || h.endsWith('.' + x))) return p;
    return 'other';
  } catch { return null; }
}
const pname = (p) => (PLATFORM_META[p] || PLATFORM_META.other).name;

/* ------------------------------------------------------------------ API */
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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

/* ------------------------------------------------------------------ toasts */
function toast(msg, type = 'info', { action, onAction, timeout = 4200 } = {}) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'ok' ? 'check-circle' : type === 'err' ? 'alert' : 'info';
  el.innerHTML = `<span class="ti">${icon(ic)}</span><span>${esc(msg)}</span>${action ? `<button class="ta">${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('.ta').addEventListener('click', () => { onAction?.(); close(); });
  wrap.appendChild(el);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  setTimeout(close, timeout);
}

/* ------------------------------------------------------------------ theme / language */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  store.raw('theme', theme);
  const old = $('#themeIcon');
  if (old) { const tpl = document.createElement('template'); tpl.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon'); const svg = tpl.content.firstElementChild; svg.id = 'themeIcon'; old.replaceWith(svg); }
  $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#0b0a14' : '#f7f6fc');
}

function applyI18n(root = document) {
  $$('[data-i18n]', root).forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]', root).forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$('[data-i18n-placeholder]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $$('[data-i18n-label]', root).forEach((el) => { el.label = t(el.dataset.i18nLabel); });
}

function setLang(lang) {
  state.lang = STRINGS[lang] ? lang : 'en';
  document.documentElement.lang = state.lang;
  store.raw('lang', state.lang);
  $('#langLabel').textContent = state.lang === 'bn' ? 'EN' : 'বাংলা';
  applyI18n();
  renderHeroTitle();
  renderStatic();
  renderBatchCount();
  if (state.info) (state.info.type === 'playlist' ? renderPlaylist : renderVideo)(state.info, true);
  renderQueue();
  renderHistory();
  renderSettings();
}

/* ------------------------------------------------------------------ hero rotator */
const ROTATE = ['YouTube', 'Facebook', 'Instagram', 'X (Twitter)', 'TikTok'];
let rotIdx = 0;
function renderHeroTitle() {
  const h = $('.hero-title');
  const word = `<span class="rotator"><span class="rotator-word" id="rotator">${esc(ROTATE[rotIdx])}</span></span>`;
  h.innerHTML = t('hero.title').replace('{p}', word);
}
function startRotator() {
  setInterval(() => {
    const el = $('#rotator');
    if (!el || document.hidden) return;
    el.classList.add('out');
    setTimeout(() => {
      rotIdx = (rotIdx + 1) % ROTATE.length;
      el.textContent = ROTATE[rotIdx];
      el.classList.remove('out');
      el.classList.add('in');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('in')));
    }, 350);
  }, 2400);
}

/* ------------------------------------------------------------------ static sections */
const FEATURES = [
  ['zap', 'f1'], ['hd', 'f2'], ['music', 'f3'], ['shield', 'f4'], ['layers', 'f5'], ['scissors', 'f6'],
  ['captions', 'f7'], ['skip', 'f8'], ['image', 'f9'], ['smartphone', 'f10'], ['globe', 'f11'], ['lock', 'f12'],
];
const PLATFORM_CARDS = ['youtube', 'facebook', 'instagram', 'twitter', 'tiktok'];

function renderStatic() {
  $('#platformChips').innerHTML = PLATFORM_CARDS.map((p) => `
    <button type="button" class="pchip" data-chip="${p}"><span class="pdot pf-${p}">${brandIcon(p)}</span>${esc(pname(p))}</button>`).join('')
    + `<span class="pchip more">${esc(t('chips.more'))}</span>`;

  $('#featuresGrid').innerHTML = FEATURES.map(([ic, k]) => `
    <div class="feature"><div class="fi">${icon(ic)}</div><h3>${esc(t(k + '.t'))}</h3><p>${esc(t(k + '.d'))}</p></div>`).join('');

  $('#platformGrid').innerHTML = PLATFORM_CARDS.map((p) => `
    <div class="pcard"><div class="picon pf-${p}">${brandIcon(p)}</div><h3>${esc(pname(p))}</h3>
      <p>${esc(t('pc.' + p + '.d'))}</p>
      <div class="ptags">${t('pc.' + p + '.tags').split(',').map((x) => `<span>${esc(x.trim())}</span>`).join('')}</div></div>`).join('');

  const faqs = [];
  for (let i = 1; STRINGS.en['faq.q' + i]; i++) faqs.push(i);
  $('#faqList').innerHTML = faqs.map((i) => `<details><summary>${esc(t('faq.q' + i))}</summary><div class="ans">${t('faq.a' + i)}</div></details>`).join('');
  if (state.health) $('#footerVersion').textContent = `v${state.health.version} · yt-dlp ${state.health.yt_dlp}`;
}

/* ------------------------------------------------------------------ input handling */
const input = () => $('#urlInput');
function updatePlatformBadge() {
  const val = input().value.trim();
  const url = extractUrl(val);
  const p = url ? detectPlatform(url) : null;
  const badge = $('#sbPlatform');
  badge.className = 'sb-platform' + (p ? ` detected pf-${p}` : '');
  badge.innerHTML = p ? brandIcon(p) : icon('link');
  $('#clearBtn').classList.toggle('hidden', !val);
}

function setMode(mode, focus = true) {
  state.mode = mode;
  $$('.mode-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#urlForm').classList.toggle('hidden', mode !== 'single');
  $('#batchForm').classList.toggle('hidden', mode !== 'batch');
  if (focus) (mode === 'single' ? input() : $('#batchInput')).focus();
}

function batchUrls() {
  const seen = new Set();
  return $('#batchInput').value.split(/\s+/).map(extractUrl).filter((u) => u && !seen.has(u) && seen.add(u));
}
function renderBatchCount() {
  const n = batchUrls().length;
  $('#batchCount').textContent = t('batch.count', { n: fmtNum(n) });
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const url = extractUrl(text);
    if (!url) { toast(t('err.noLinkClipboard'), 'err'); return; }
    if (state.mode === 'batch') { $('#batchInput').value += ($('#batchInput').value ? '\n' : '') + text.trim(); renderBatchCount(); return; }
    input().value = url;
    updatePlatformBadge();
    if (state.settings.autoFetch) fetchInfo(url);
  } catch {
    toast(t('err.clipboard'), 'info');
    input().focus();
  }
}

/* ------------------------------------------------------------------ fetch info */
function setLoading(on) {
  const b = $('#fetchBtn');
  b.classList.toggle('loading', on);
  b.disabled = on;
}

async function fetchInfo(raw, { playlist = false } = {}) {
  const url = extractUrl(raw);
  if (!url) {
    toast(t('err.invalidUrl'), 'err');
    input().focus();
    return;
  }
  setMode('single', false);
  input().value = url;
  updatePlatformBadge();
  state.infoUrl = url;
  state.rowJobs = {};
  state.plMap = {};
  const token = ++state.fetchToken;
  setLoading(true);
  renderSkeleton(detectPlatform(url), playlist);
  scrollToResult();
  try {
    const data = await api('/api/info', { method: 'POST', body: { url, playlist } });
    if (token !== state.fetchToken) return;
    state.info = data;
    if (data.type === 'playlist') renderPlaylist(data); else renderVideo(data);
    addHistory(data, url);
    requestAnimationFrame(() => scrollToResult(true));
  } catch (e) {
    if (token !== state.fetchToken) return;
    state.info = null;
    renderError(e, url, playlist);
  } finally {
    if (token === state.fetchToken) { setLoading(false); clearInterval(skeletonTimer); }
  }
}

function scrollToResult(onlyIfHidden = false) {
  const el = $('#result');
  const navH = ($('.nav')?.offsetHeight || 64) + 14;
  const top = el.getBoundingClientRect().top;
  if (onlyIfHidden && top >= navH - 4 && top < window.innerHeight * 0.6) return;
  window.scrollTo({ top: Math.max(0, top + window.scrollY - navH), behavior: 'smooth' });
}

let skeletonTimer = null;
function renderSkeleton(platform, playlist) {
  clearInterval(skeletonTimer);
  const msgs = [t('load.connect', { p: pname(platform || 'other') }), t('load.reading'), playlist ? t('load.playlist') : t('load.formats'), t('load.almost')];
  $('#result').innerHTML = `
    <div class="card skeleton-card">
      <div class="rc-top">
        <div class="sk" style="aspect-ratio:16/9;border-radius:16px"></div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="sk" style="height:26px;width:85%"></div><div class="sk" style="height:26px;width:60%"></div>
          <div class="sk" style="height:18px;width:40%"></div>
          <div style="display:flex;gap:8px"><div class="sk" style="height:28px;width:90px;border-radius:99px"></div><div class="sk" style="height:28px;width:70px;border-radius:99px"></div><div class="sk" style="height:28px;width:110px;border-radius:99px"></div></div>
          <div class="sk" style="height:54px;width:100%"></div>
        </div>
      </div>
      <div class="sk-status"><span class="spinner"></span><span id="skMsg">${esc(msgs[0])}</span></div>
      <div style="display:grid;gap:8px;margin-top:18px">${'<div class="sk" style="height:58px"></div>'.repeat(3)}</div>
    </div>`;
  let i = 0;
  skeletonTimer = setInterval(() => {
    const el = $('#skMsg');
    if (!el) return clearInterval(skeletonTimer);
    i = Math.min(i + 1, msgs.length - 1);
    el.textContent = msgs[i];
  }, 1800);
}

function renderError(e, url, playlist) {
  const tips = t('tip.' + (e.code || 'failed'));
  $('#result').innerHTML = `
    <div class="card error-card">
      <div class="ei">${icon('alert')}</div>
      <h3>${esc(t('err.title'))}</h3>
      <p>${esc(e.message)}</p>
      ${tips && !tips.startsWith('tip.') ? `<p class="tips">${esc(tips)}</p>` : '<div style="height:12px"></div>'}
      <div class="actions">
        <button class="btn btn-primary" id="retryInfo">${icon('refresh')}<span>${esc(t('err.retry'))}</span></button>
        <button class="btn btn-ghost" id="clearInfo">${icon('x')}<span>${esc(t('err.another'))}</span></button>
      </div>
    </div>`;
  $('#retryInfo').onclick = () => fetchInfo(url, { playlist });
  $('#clearInfo').onclick = () => { $('#result').innerHTML = ''; input().value = ''; updatePlatformBadge(); input().focus(); };
}

/* ------------------------------------------------------------------ single video view */
const stat = (ic, text) => `<span class="stat">${icon(ic)}${esc(text)}</span>`;
const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

function renderVideo(d, keepTab = false) {
  const prevTab = keepTab ? ($('.rc-tab.active')?.dataset.tab || 'video') : 'video';
  const prevAdv = keepTab ? readAdvancedRaw() : null;
  const first = d.video[0];
  const portrait = first && first.width && first.height && first.height > first.width;
  const stats = [
    d.view_count != null && stat('eye', t('meta.views', { n: fmtCompact(d.view_count) })),
    d.like_count != null && stat('heart', fmtCompact(d.like_count)),
    d.comment_count != null && stat('message', fmtCompact(d.comment_count)),
    d.upload_date && stat('calendar', fmtDate(d.upload_date)),
  ].filter(Boolean).join('');
  const tabs = [
    ['video', 'film', t('tab.video'), d.video.length],
    ['audio', 'music', t('tab.audio'), d.audio.length],
    ['thumbs', 'image', t('tab.thumbs'), d.thumbnails.length],
    d.subtitles.length ? ['subs', 'captions', t('tab.subs'), d.subtitles.length] : null,
    ['advanced', 'sliders', t('tab.advanced'), null],
  ].filter(Boolean);
  const maxMin = state.config?.max_duration_minutes;

  $('#result').innerHTML = `
  <article class="card result-card">
    <div class="rc-top">
      <div class="rc-thumb ${portrait ? 'portrait' : ''}" id="rcThumb" role="button" tabindex="0" aria-label="${esc(t('rc.preview'))}">
        ${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" onerror="this.remove()">` : ''}
        <div class="play"><span>${icon('play')}</span></div>
        ${d.duration ? `<span class="rc-duration">${fmtDur(d.duration)}</span>` : ''}
        <span class="rc-pf pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(pname(d.platform))}</span>
      </div>
      <div class="rc-meta">
        <h2 class="rc-title">${esc(d.title)}</h2>
        ${d.uploader ? `<div class="rc-uploader"><span class="avatar">${esc(initial(d.uploader))}</span><span>${esc(d.uploader)}</span>${d.verified ? `<span class="verified" title="Verified">${icon('verified')}</span>` : ''}</div>` : ''}
        ${stats ? `<div class="rc-stats">${stats}</div>` : ''}
        ${d.description ? `<p class="rc-desc" id="rcDesc" title="${esc(t('rc.more'))}">${esc(d.description)}</p>` : ''}
        ${d.is_live ? `<div class="notice">${icon('alert')}<div>${esc(t('rc.live'))}</div></div>` : ''}
        ${d.too_long ? `<div class="notice">${icon('alert')}<div>${esc(t('rc.tooLong', { m: localDigits(maxMin) }))}</div></div>` : ''}
        ${d.playlist_url ? `<div class="notice info">${icon('list')}<div>${esc(t('rc.inPlaylist'))} <button class="chip-btn" id="loadPlaylistBtn" style="margin:6px 0 0">${icon('list')}${esc(t('rc.loadPlaylist'))}</button></div></div>` : ''}
        <div class="rc-links">
          <a class="chip-btn" href="${esc(d.webpage_url)}" target="_blank" rel="noopener noreferrer">${icon('external')}${esc(t('rc.open'))}</a>
          <button class="chip-btn" type="button" data-copy="${esc(d.webpage_url)}">${icon('copy')}${esc(t('rc.copy'))}</button>
          ${navigator.share ? `<button class="chip-btn" type="button" id="shareBtn">${icon('share')}${esc(t('rc.share'))}</button>` : ''}
        </div>
      </div>
    </div>
    <div class="rc-tabs" role="tablist">
      ${tabs.map(([id, ic, label, n]) => `<button class="rc-tab" type="button" role="tab" data-tab="${id}">${icon(ic)}${esc(label)}${n != null ? `<span class="count">${localDigits(n)}</span>` : ''}${id === 'advanced' ? '<span class="dot-on hidden" id="advDot"></span>' : ''}</button>`).join('')}
    </div>
    <div class="adv-active hidden" id="advActive"></div>
    <div class="rc-panel" data-panel="video">${videoPanel(d)}</div>
    <div class="rc-panel hidden" data-panel="audio">${audioPanel(d)}</div>
    <div class="rc-panel hidden" data-panel="thumbs">${thumbsPanel(d)}</div>
    ${d.subtitles.length ? `<div class="rc-panel hidden" data-panel="subs">${subsPanel(d)}</div>` : ''}
    <div class="rc-panel hidden" data-panel="advanced">${advancedPanel(d)}</div>
  </article>`;

  hydrateIcons($('#result'));
  switchTab(tabs.some((x) => x[0] === prevTab) ? prevTab : 'video');
  if (prevAdv) writeAdvancedRaw(prevAdv);
  bindResult(d);
  updateAdvancedIndicator();
  updateRowButtons();
}

function dlButton(kind, quality, label) {
  return `<button class="btn-dl" type="button" data-dl data-kind="${kind}" data-quality="${esc(quality)}" data-label="${esc(label)}">${icon('download')}<span>${esc(t('btn.download'))}</span></button>`;
}

function videoPanel(d) {
  if (!d.video.length) return `<div class="empty-note">${esc(t('rc.noVideo'))}</div>`;
  return `<div class="fmt-list">${d.video.map((v) => {
    const extra = [v.ext.toUpperCase(), v.codec, v.fps && v.fps > 30 ? `${v.fps}fps` : ''].filter(Boolean).join(' · ');
    return `<div class="fmt-row">
      <span class="q-badge q-${v.badge}">${esc(v.badge)}</span>
      <div class="fmt-main"><b>${esc(v.label)}${v.hdr ? ' <span class="tag hdr">HDR</span>' : ''}${v === d.video[0] ? ` <span class="tag">${esc(t('rc.best'))}</span>` : ''}</b><small>${esc(extra)}${v.width && v.height ? ` · ${localDigits(v.width)}×${localDigits(v.height)}` : ''}</small></div>
      <span class="fmt-size">${v.size ? '~' + fmtBytes(v.size) : '—'}</span>
      ${dlButton('video', v.id === 'best' ? 'best' : v.id, v.label)}
    </div>`;
  }).join('')}</div>`;
}

function audioPanel(d) {
  if (!d.audio.length) return `<div class="empty-note">${esc(t('rc.noAudio'))}</div>`;
  return `<div class="fmt-list">${d.audio.map((a) => {
    const title = a.tier === 'kbps' ? `${localDigits(a.kbps)} kbps` : t('aq.' + a.tier);
    const upsampled = a.tier === 'kbps' && a.src_kbps && a.kbps > a.src_kbps + 16;
    const detail = [a.label, a.label === 'M4A' ? 'AAC' : '', a.label === 'WAV' ? 'PCM' : '',
      a.tier === 'original' && a.src_kbps ? `~${localDigits(a.src_kbps)} kbps` : '',
      upsampled ? t('aq.source', { k: localDigits(a.src_kbps) }) : '',
      a.tier === 'kbps' && a.kbps <= 128 ? t('aq.small') : ''].filter(Boolean).join(' · ');
    return `<div class="fmt-row">
      <span class="q-badge ${a.label === 'MP3' ? 'q-AUD' : 'q-AUD2'}">${esc(a.label)}</span>
      <div class="fmt-main"><b>${esc(title)}${a.popular ? ` <span class="tag">${esc(t('rc.popular'))}</span>` : ''}</b><small>${esc(detail)}</small></div>
      <span class="fmt-size">${a.size ? '~' + fmtBytes(a.size) : '—'}</span>
      ${dlButton('audio', a.id, a.label)}
    </div>`;
  }).join('')}</div>`;
}

function thumbsPanel(d) {
  if (!d.thumbnails.length) return `<div class="empty-note">${esc(t('rc.noThumbs'))}</div>`;
  return `<div class="thumb-grid">${d.thumbnails.map((th) => `
    <div class="thumb-card"><div class="ti"><img loading="lazy" src="${esc(th.url)}" alt="" onerror="this.remove()"></div>
      <div class="tf"><span>${esc(localDigits(th.label === 'Original' ? t('rc.original') : th.label))}</span>
      <a class="chip-btn" href="${esc(th.download)}" download>${icon('download')}${esc(t('btn.save'))}</a></div></div>`).join('')}</div>`;
}

function subsPanel(d) {
  return `<div class="sub-list">${d.subtitles.map((s) => `
    <div class="sub-row">
      <div class="sl"><b>${esc(s.name)}</b><small>${esc(s.lang)} · ${esc(s.auto ? (s.translated ? t('subs.translated') : t('subs.auto')) : t('subs.manual'))}</small></div>
      <button class="chip-btn" type="button" data-sub="${esc(s.lang)}" data-auto="${s.auto ? 1 : 0}" data-fmt="srt">SRT</button>
      <button class="chip-btn" type="button" data-sub="${esc(s.lang)}" data-auto="${s.auto ? 1 : 0}" data-fmt="vtt">VTT</button>
    </div>`).join('')}</div>`;
}

function advancedPanel(d) {
  const subOpts = d.subtitles.map((s) => `<option value="${esc(s.lang)}">${esc(s.name)}${s.auto ? ' (auto)' : ''}</option>`).join('');
  const chapters = (d.chapters || []).filter((c) => c.start != null);
  return `
  <div class="adv-grid">
    <div class="adv-block">
      <h4>${icon('scissors')}${esc(t('adv.trim'))}</h4>
      <div class="row2">
        <label class="field">${esc(t('adv.start'))}<input class="input" id="trimStart" inputmode="numeric" placeholder="0:00"></label>
        <label class="field">${esc(t('adv.end'))}<input class="input" id="trimEnd" inputmode="numeric" placeholder="${d.duration ? fmtDur(d.duration).replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)) : '1:30'}"></label>
      </div>
      ${chapters.length ? `<select class="select" id="chapterSel"><option value="">${esc(t('adv.chapter'))}</option>${chapters.map((c, i) => `<option value="${i}">${esc(fmtDur(c.start))} — ${esc(c.title)}</option>`).join('')}</select>` : ''}
      <label class="switch"><input type="checkbox" id="preciseCut"><span class="track"></span>${esc(t('adv.precise'))}</label>
      <p>${esc(t('adv.trimHint'))}</p>
    </div>
    <div class="adv-block">
      <h4>${icon('wand')}${esc(t('adv.quality'))}</h4>
      <label class="switch"><input type="checkbox" id="preferH264" ${state.settings.preferH264 ? 'checked' : ''}><span class="track"></span>${esc(t('adv.h264'))}</label>
      <label class="switch"><input type="checkbox" id="embedMeta"><span class="track"></span>${esc(t('adv.meta'))}</label>
      <p>${esc(t('adv.h264Hint'))}</p>
    </div>
    ${d.sponsorblock ? `<div class="adv-block">
      <h4>${icon('skip')}SponsorBlock</h4>
      <label class="switch"><input type="checkbox" id="sponsorBlock"><span class="track"></span>${esc(t('adv.sponsor'))}</label>
      <p>${esc(t('adv.sponsorHint'))}</p>
    </div>` : ''}
    ${d.subtitles.length ? `<div class="adv-block">
      <h4>${icon('captions')}${esc(t('adv.subs'))}</h4>
      <label class="switch"><input type="checkbox" id="embedSubs"><span class="track"></span>${esc(t('adv.embedSubs'))}</label>
      <select class="select" id="subLang">${subOpts}</select>
    </div>` : ''}
    <div class="adv-block">
      <h4>${icon('type')}${esc(t('adv.filename'))}</h4>
      <input class="input" id="customName" maxlength="140" placeholder="${esc(truncate(d.title, 60))}">
      <p>${esc(t('adv.filenameHint'))}</p>
    </div>
  </div>
  <div class="adv-foot"><span>${icon('info')} ${esc(t('adv.note'))}</span><button class="chip-btn" type="button" id="advReset">${icon('refresh')}${esc(t('adv.reset'))}</button></div>`;
}

const TIME_RE = /^\d+(:\d{1,2}){0,2}(\.\d+)?$/;
const asciiDigits = (s) => String(s || '').replace(/[০-৯]/g, (c) => '০১২৩৪৫৬৭৮৯'.indexOf(c)).trim();
const ADV_IDS = ['trimStart', 'trimEnd', 'preciseCut', 'preferH264', 'embedMeta', 'sponsorBlock', 'embedSubs', 'subLang', 'customName'];
function readAdvancedRaw() {
  const out = {};
  for (const id of ADV_IDS) { const el = document.getElementById(id); if (el) out[id] = el.type === 'checkbox' ? el.checked : el.value; }
  return out;
}
function writeAdvancedRaw(v) {
  for (const [id, val] of Object.entries(v || {})) { const el = document.getElementById(id); if (!el) continue; if (el.type === 'checkbox') el.checked = !!val; else el.value = val; }
}
function readAdvanced(kind) {
  const r = readAdvancedRaw();
  const o = {};
  const ts = asciiDigits(r.trimStart), te = asciiDigits(r.trimEnd);
  if (ts) o.trim_start = ts;
  if (te) o.trim_end = te;
  if (r.preciseCut && (ts || te)) o.precise_cut = true;
  if (r.sponsorBlock && kind === 'video') o.sponsorblock = true;
  if (r.embedSubs && r.subLang && kind === 'video') { o.embed_subs = true; o.sub_lang = r.subLang; }
  o.prefer_h264 = r.preferH264 ?? state.settings.preferH264;
  if (kind === 'video' && r.embedMeta) o.embed_metadata = true;
  if ((r.customName || '').trim()) o.filename = r.customName.trim();
  return o;
}
function validateAdvanced() {
  let ok = true;
  for (const id of ['trimStart', 'trimEnd']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = asciiDigits(el.value);
    const bad = v && !TIME_RE.test(v);
    el.classList.toggle('invalid', !!bad);
    if (bad) ok = false;
  }
  if (!ok) { toast(t('err.time'), 'err'); switchTab('advanced'); }
  return ok;
}
function updateAdvancedIndicator() {
  const r = readAdvancedRaw();
  const parts = [];
  if ((r.trimStart || '').trim() || (r.trimEnd || '').trim()) parts.push(`${t('adv.trim')}: ${r.trimStart || '0:00'} → ${r.trimEnd || t('adv.endShort')}`);
  if (r.sponsorBlock) parts.push('SponsorBlock');
  if (r.embedSubs) parts.push(t('adv.subs'));
  if (r.embedMeta) parts.push(t('adv.metaShort'));
  if (r.preferH264 === false) parts.push(t('adv.noH264'));
  if ((r.customName || '').trim()) parts.push(t('adv.filename'));
  const on = parts.length > 0;
  $('#advDot')?.classList.toggle('hidden', !on);
  const box = $('#advActive');
  if (!box) return;
  box.classList.toggle('hidden', !on);
  box.innerHTML = on ? `<div class="notice info" style="margin-bottom:12px">${icon('sliders')}<div><b>${esc(t('adv.active'))}</b> ${esc(parts.join(' · '))}</div></div>` : '';
}

function switchTab(id) {
  $$('.rc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  $$('.rc-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== id));
}

function bindResult(d) {
  const root = $('#result');
  $$('.rc-tab', root).forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#rcDesc')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
  $('#loadPlaylistBtn')?.addEventListener('click', () => fetchInfo(d.playlist_url, { playlist: true }));
  $('#shareBtn')?.addEventListener('click', () => navigator.share({ title: d.title, url: d.webpage_url }).catch(() => {}));
  const th = $('#rcThumb');
  const preview = () => {
    if (d.platform === 'youtube' && d.id) openModal(d.title, `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(d.id)}?autoplay=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`);
    else window.open(d.webpage_url, '_blank', 'noopener');
  };
  th?.addEventListener('click', preview);
  th?.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });

  $$('[data-dl]', root).forEach((btn) => btn.addEventListener('click', () => onRowDownload(btn)));
  $$('[data-sub]', root).forEach((btn) => btn.addEventListener('click', () => downloadSubtitle(btn, d)));

  const adv = $('[data-panel="advanced"]', root);
  adv.addEventListener('input', updateAdvancedIndicator);
  adv.addEventListener('change', updateAdvancedIndicator);
  $('#chapterSel')?.addEventListener('change', (e) => {
    const c = d.chapters[+e.target.value];
    if (!c) return;
    $('#trimStart').value = fmtDur(c.start).replace(/[০-৯]/g, (x) => '০১২৩৪৫৬৭৮৯'.indexOf(x));
    $('#trimEnd').value = c.end != null ? fmtDur(c.end).replace(/[০-৯]/g, (x) => '০১২৩৪৫৬৭৮৯'.indexOf(x)) : '';
    updateAdvancedIndicator();
  });
  $('#advReset')?.addEventListener('click', () => {
    writeAdvancedRaw({ trimStart: '', trimEnd: '', preciseCut: false, preferH264: state.settings.preferH264, embedMeta: false, sponsorBlock: false, embedSubs: false, customName: '' });
    $('#chapterSel') && ($('#chapterSel').value = '');
    $$('.input.invalid', root).forEach((x) => x.classList.remove('invalid'));
    updateAdvancedIndicator();
  });
}

async function onRowDownload(btn) {
  const key = `${btn.dataset.kind}:${btn.dataset.quality}`;
  const jid = state.rowJobs[key];
  const job = jid && state.jobs.get(jid);
  if (job && job.status === 'finished') return saveFile(job);
  if (job && ACTIVE.has(job.status)) return openDrawer('queue');
  if (!validateAdvanced()) return;
  const d = state.info;
  const kind = btn.dataset.kind;
  btn.disabled = true;
  try {
    const created = await submitJob({
      url: state.infoUrl, kind, quality: btn.dataset.quality, label: btn.dataset.label,
      title: d?.title, thumbnail: d?.thumbnail, options: readAdvanced(kind),
    });
    if (created) state.rowJobs[key] = created.id;
  } finally {
    btn.disabled = false;
    updateRowButtons();
  }
}

function updateRowButtons() {
  $$('[data-dl]').forEach((btn) => {
    const job = state.jobs.get(state.rowJobs[`${btn.dataset.kind}:${btn.dataset.quality}`]);
    btn.classList.remove('is-busy', 'is-done', 'is-error', 'indeterminate');
    btn.style.removeProperty('--p');
    if (!job) { btn.innerHTML = `${icon('download')}<span>${esc(t('btn.download'))}</span>`; return; }
    if (job.status === 'finished') { btn.classList.add('is-done'); btn.innerHTML = `${icon('save')}<span>${esc(t('btn.saveFile'))}</span>`; return; }
    if (job.status === 'error' || job.status === 'cancelled') { btn.classList.add('is-error'); btn.innerHTML = `${icon('refresh')}<span>${esc(t('btn.retry'))}</span>`; return; }
    btn.classList.add('is-busy');
    const indet = job.status !== 'downloading' || !job.progress;
    btn.classList.toggle('indeterminate', indet);
    btn.style.setProperty('--p', `${job.progress}%`);
    const label = job.status === 'downloading' && job.progress ? localDigits(`${Math.floor(job.progress)}%`) : t('stage.short.' + job.status);
    btn.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`;
  });
}

async function downloadSubtitle(btn, d) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;border-color:var(--border-strong);border-top-color:var(--text)"></span>';
  try {
    const res = await api('/api/subtitles', { method: 'POST', raw: true, body: { url: state.infoUrl, lang: btn.dataset.sub, auto: btn.dataset.auto === '1', fmt: btn.dataset.fmt } });
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const name = m ? decodeURIComponent(m[1]) : `${truncate(d.title, 80)} [${btn.dataset.sub}].${btn.dataset.fmt}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(t('toast.subSaved'), 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ------------------------------------------------------------------ playlist view */
const PRESETS = [
  ['video:best', 'preset.vbest'], ['video:1080', 'preset.v1080'], ['video:720', 'preset.v720'], ['video:480', 'preset.v480'], ['video:360', 'preset.v360'],
  ['audio:mp3-320', 'preset.mp3320'], ['audio:mp3-128', 'preset.mp3128'], ['audio:m4a', 'preset.m4a'],
];
function presetSelect(id, selected = 'video:720') {
  return `<select class="select" id="${id}">${PRESETS.map(([v, k]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>`;
}

function renderPlaylist(d, keep = false) {
  const prevChecked = keep ? new Set($$('.pl-check:checked').map((c) => +c.dataset.idx)) : null;
  const prevPreset = keep ? $('#plPreset')?.value : null;
  $('#result').innerHTML = `
  <article class="card pl-card">
    <div class="pl-head">
      <div class="ph">${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" onerror="this.remove()">` : ''}</div>
      <div style="min-width:0">
        <span class="pl-kicker pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(t('pl.kicker', { p: pname(d.platform) }))}</span>
        <h2>${esc(d.title)}</h2>
        <p>${[d.uploader ? esc(d.uploader) : '', esc(t('pl.count', { n: fmtNum(d.count) })), d.shown < d.count ? esc(t('pl.showing', { n: fmtNum(d.shown) })) : ''].filter(Boolean).join(' · ')}</p>
      </div>
    </div>
    <div class="pl-toolbar">
      <label class="check"><input type="checkbox" id="plAll" checked><span>${esc(t('pl.selectAll'))}</span></label>
      <span class="grow"></span>
      ${presetSelect('plPreset', prevPreset || 'video:720')}
      <button class="btn btn-primary" type="button" id="plGo">${icon('download')}<span id="plGoLabel"></span></button>
    </div>
    <div class="pl-list">${d.entries.map((e) => `
      <div class="pl-item">
        <input type="checkbox" class="pl-check" data-idx="${e.index}" ${e.nested ? 'disabled' : 'checked'} aria-label="${esc(e.title)}">
        <span class="idx">${localDigits(e.index)}</span>
        <div class="pt">${e.thumbnail ? `<img loading="lazy" src="${esc(e.thumbnail)}" alt="" onerror="this.remove()">` : ''}${e.duration ? `<span>${fmtDur(e.duration)}</span>` : ''}</div>
        <div class="pi"><b title="${esc(e.title)}">${esc(e.title)}</b><small>${esc(e.uploader || '')}</small></div>
        <div class="pa"><span class="pl-state hidden" data-plstate="${e.index}"></span>${e.url ? `<button class="chip-btn" type="button" data-plopen="${esc(e.url)}">${icon('eye')}${esc(t('pl.open'))}</button>` : ''}</div>
      </div>`).join('')}</div>
  </article>`;
  if (prevChecked) $$('.pl-check').forEach((c) => { c.checked = prevChecked.has(+c.dataset.idx); });
  const refresh = () => {
    const n = $$('.pl-check:checked').length;
    $('#plGoLabel').textContent = t('pl.download', { n: fmtNum(n) });
    $('#plGo').disabled = n === 0;
    const all = $$('.pl-check:not(:disabled)');
    $('#plAll').checked = all.length > 0 && all.every((c) => c.checked);
  };
  $('#plAll').addEventListener('change', (e) => { $$('.pl-check:not(:disabled)').forEach((c) => { c.checked = e.target.checked; }); refresh(); });
  $$('.pl-check').forEach((c) => c.addEventListener('change', refresh));
  $$('[data-plopen]').forEach((b) => b.addEventListener('click', () => fetchInfo(b.dataset.plopen)));
  $('#plGo').addEventListener('click', () => {
    const [kind, quality] = $('#plPreset').value.split(':');
    const label = quality === 'best' ? 'best' : (kind === 'video' ? `${quality}p` : quality.toUpperCase());
    const chosen = $$('.pl-check:checked').map((c) => d.entries.find((e) => e.index === +c.dataset.idx)).filter(Boolean);
    chosen.forEach((e) => {
      const body = e.url
        ? { url: e.url, kind, quality, label, title: e.title, thumbnail: e.thumbnail, options: { prefer_h264: state.settings.preferH264 } }
        : { url: d.url, playlist_index: e.index, kind, quality, label, title: e.title, thumbnail: e.thumbnail, options: { prefer_h264: state.settings.preferH264 } };
      const cid = enqueue(body);
      state.plMap[e.index] = cid;
    });
    toast(t('toast.addedMany', { n: fmtNum(chosen.length) }), 'ok', { action: t('toast.view'), onAction: () => openDrawer('queue') });
    updatePlaylistStates();
  });
  refresh();
  updatePlaylistStates();
}

function updatePlaylistStates() {
  if (!state.info || state.info.type !== 'playlist') return;
  for (const [idx, ref] of Object.entries(state.plMap)) {
    const el = document.querySelector(`[data-plstate="${idx}"]`);
    if (!el) continue;
    const realId = state.pendingMap?.[ref] || ref;
    const job = state.jobs.get(realId);
    const pend = state.pending.find((p) => p.cid === ref);
    el.classList.remove('hidden', 'ok', 'err');
    if (pend) el.textContent = t('stage.short.waiting');
    else if (!job) el.classList.add('hidden');
    else if (job.status === 'finished') { el.classList.add('ok'); el.textContent = '✓ ' + t('stage.short.finished'); }
    else if (job.status === 'error' || job.status === 'cancelled') { el.classList.add('err'); el.textContent = '✕ ' + t('stage.short.error'); }
    else el.textContent = job.status === 'downloading' && job.progress ? localDigits(`${Math.floor(job.progress)}%`) : t('stage.short.' + job.status);
  }
}

/* ------------------------------------------------------------------ job submission & client queue */
state.pendingMap = {};

async function submitJob(body, { silent = false } = {}) {
  try {
    const job = await api('/api/download', { method: 'POST', body });
    registerJob(job, body);
    if (!silent) toast(t('toast.queued', { t: truncate(job.title || body.title || job.url, 42) }), 'ok', { action: t('toast.view'), onAction: () => openDrawer('queue') });
    return job;
  } catch (e) {
    if (!silent) toast(e.message, 'err');
    throw e;
  }
}

function registerJob(job, body) {
  state.jobs.set(job.id, job);
  state.jobMeta[job.id] = { req: body, created: Date.now(), saved: false };
  persistJobs();
  renderQueue();
  updateBadge();
  pulseQueue();
  ensurePolling();
}

function persistJobs() {
  const keep = {};
  for (const [id, m] of Object.entries(state.jobMeta)) if (state.jobs.has(id) || Date.now() - m.created < 3600e3) keep[id] = m;
  state.jobMeta = keep;
  store.set('jobs', keep);
}

let cidSeq = 0;
function enqueue(body) {
  const cid = `p${Date.now().toString(36)}${(cidSeq++).toString(36)}`;
  state.pending.push({ cid, body, title: body.title || body.url, thumbnail: body.thumbnail, added: Date.now() });
  renderQueue();
  updateBadge();
  pumpPending();
  return cid;
}

let pumping = false;
let pumpBlockedUntil = 0;
async function pumpPending() {
  if (pumping || Date.now() < pumpBlockedUntil) return;
  pumping = true;
  try {
    while (state.pending.length) {
      const active = [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
      if (active >= MAX_PARALLEL) break;
      const item = state.pending.shift();
      try {
        const job = await submitJob(item.body, { silent: true });
        state.pendingMap[item.cid] = job.id;
      } catch (e) {
        if (e.status === 429) { state.pending.unshift(item); pumpBlockedUntil = Date.now() + 10000; ensurePolling(); break; }
        toast(`${truncate(item.title, 40)}: ${e.message}`, 'err');
      }
      renderQueue();
      updatePlaylistStates();
      await sleep(250);
    }
  } finally {
    pumping = false;
    updateBadge();
  }
}

function ensurePolling() { if (!state.pollTimer) state.pollTimer = setTimeout(poll, 400); }

async function poll() {
  state.pollTimer = null;
  const ids = [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).map((j) => j.id);
  if (ids.length) {
    try {
      const res = await api('/api/jobs?ids=' + ids.join(','));
      res.jobs.forEach(onJobUpdate);
      res.missing.forEach((id) => { const j = state.jobs.get(id); if (j) onJobUpdate({ ...j, status: 'error', stage: 'error', error: t('err.expired'), error_code: 'expired' }); });
    } catch { /* network hiccup: retry next tick */ }
  }
  pumpPending();
  const still = [...state.jobs.values()].some((j) => ACTIVE.has(j.status)) || state.pending.length;
  if (still) state.pollTimer = setTimeout(poll, document.hidden ? 3000 : 900);
}

function onJobUpdate(j) {
  const prev = state.jobs.get(j.id);
  state.jobs.set(j.id, j);
  if (prev && prev.status !== j.status) {
    if (j.status === 'finished') onJobFinished(j);
    else if (j.status === 'error') toast(`${truncate(j.title || j.url, 36)} — ${j.error}`, 'err', { timeout: 6500 });
  }
  renderQueueItem(j);
  updateRowButtons();
  updatePlaylistStates();
  updateBadge();
}

function onJobFinished(j) {
  const meta = state.jobMeta[j.id] || (state.jobMeta[j.id] = { created: Date.now() });
  if (state.settings.autoSave && !meta.saved) saveFile(j, true);
  else toast(t('toast.ready', { t: truncate(j.title, 40) }), 'ok', { action: t('btn.saveFile'), onAction: () => saveFile(j) });
  if (state.settings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(t('toast.readyTitle'), { body: j.title, icon: '/static/icons/icon-192.png' }); } catch { /* ignore */ }
  }
}

function saveFile(j, auto = false) {
  if (!j?.file_url) return;
  const a = document.createElement('a');
  a.href = j.file_url;
  a.download = j.filename || '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  const meta = state.jobMeta[j.id] || (state.jobMeta[j.id] = { created: Date.now() });
  meta.saved = true;
  persistJobs();
  toast(auto ? t('toast.autoSaved', { t: truncate(j.title, 40) }) : t('toast.saving'), 'ok');
}

async function cancelJob(id) {
  try { await api(`/api/jobs/${id}`, { method: 'DELETE' }); } catch { /* already gone */ }
  const j = state.jobs.get(id);
  if (j && ACTIVE.has(j.status)) onJobUpdate({ ...j, status: 'cancelled', stage: 'cancelled' });
}
async function removeJob(id) {
  const j = state.jobs.get(id);
  if (j && ACTIVE.has(j.status)) await cancelJob(id);
  else api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  state.jobs.delete(id);
  delete state.jobMeta[id];
  persistJobs();
  renderQueue();
  updateBadge();
}
function retryJob(id) {
  const meta = state.jobMeta[id];
  const j = state.jobs.get(id);
  const body = meta?.req || (j && { url: j.url, kind: j.kind, quality: j.quality, label: j.label, title: j.title, thumbnail: j.thumbnail });
  if (!body) return;
  state.jobs.delete(id);
  delete state.jobMeta[id];
  submitJob(body).then((nj) => {
    for (const [k, v] of Object.entries(state.rowJobs)) if (v === id) state.rowJobs[k] = nj.id;
    for (const [k, v] of Object.entries(state.plMap)) if (v === id || state.pendingMap[v] === id) state.plMap[k] = nj.id;
    updateRowButtons();
    updatePlaylistStates();
  }).catch(() => {});
  renderQueue();
}

function updateBadge() {
  const active = [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).length + state.pending.length;
  const ready = [...state.jobs.values()].filter((j) => j.status === 'finished' && !state.jobMeta[j.id]?.saved).length;
  const n = active || ready;
  const b = $('#queueBadge');
  b.textContent = localDigits(n > 99 ? '99+' : n);
  b.classList.toggle('show', n > 0);
  $('#queueBtn').classList.toggle('pulse', active > 0);
  const dq = $('#dqCount');
  dq.textContent = localDigits(state.jobs.size + state.pending.length);
  dq.classList.toggle('hidden', state.jobs.size + state.pending.length === 0);
}
function pulseQueue() {
  const b = $('#queueBtn');
  b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'ease-out' });
}

/* ------------------------------------------------------------------ drawer: queue */
function openDrawer(tab = 'queue') {
  switchDrawerTab(tab);
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('show');
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('show');
}
function switchDrawerTab(tab) {
  $$('.drawer-tab').forEach((b) => b.classList.toggle('active', b.dataset.dtab === tab));
  $$('[data-dpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.dpanel !== tab));
  if (tab === 'settings') { renderSettings(); refreshHealth(); }
}

function stageText(j) {
  if (j.status === 'queued') return j.queue_position ? t('q.position', { n: localDigits(j.queue_position) }) : t('stage.queued');
  if (j.status === 'finished') return `${t('stage.finished')} · ${fmtBytes(j.filesize)}`;
  if (j.status === 'error') return t('stage.error');
  return t('stage.' + (j.stage || j.status));
}

function queueItemHtml(j) {
  const kindIcon = j.kind === 'audio' ? 'music' : 'film';
  const indet = (j.status !== 'downloading' && j.status !== 'finished') || (j.status === 'downloading' && !j.progress);
  const pct = j.status === 'finished' ? 100 : j.progress || 0;
  const left = j.status === 'downloading' ? `${localDigits(Math.floor(pct))}% · ${fmtBytes(j.downloaded)}${j.total ? ' / ' + fmtBytes(j.total) : ''}` : '';
  const right = j.status === 'downloading' ? [j.speed ? fmtBytes(j.speed) + '/s' : '', j.eta != null ? t('q.eta', { t: fmtDur(j.eta) }) : ''].filter(Boolean).join(' · ') : '';
  const expires = j.expires ? Math.max(0, Math.round((j.expires * 1000 - Date.now()) / 60000)) : null;
  let actions = '';
  if (ACTIVE.has(j.status)) actions = `<button class="chip-btn danger" data-qa="cancel">${icon('x')}${esc(t('q.cancel'))}</button>`;
  else if (j.status === 'finished') actions = `<button class="chip-btn primary" data-qa="save">${icon('save')}${esc(t('btn.saveFile'))}</button><button class="chip-btn" data-qa="preview">${icon('play')}${esc(t('q.preview'))}</button><button class="chip-btn danger" data-qa="remove">${icon('trash')}</button>`;
  else actions = `<button class="chip-btn" data-qa="retry">${icon('refresh')}${esc(t('btn.retry'))}</button><button class="chip-btn danger" data-qa="remove">${icon('trash')}</button>`;
  return `
    <div class="q-thumb">${j.thumbnail ? `<img src="${esc(j.thumbnail)}" alt="" onerror="this.remove()">` : icon(kindIcon)}<span class="qk pf-${esc(j.platform)}">${brandIcon(j.platform)}</span></div>
    <div class="q-body">
      <div class="q-title" title="${esc(j.title || j.url)}">${esc(j.title || j.url)}</div>
      <div class="q-meta"><span class="q-tag">${esc(j.label || j.quality)}</span><span class="q-stage ${j.status === 'finished' ? 'ok' : j.status === 'error' ? 'err' : ''}">${esc(stageText(j))}</span></div>
      ${j.status === 'error' ? `<div class="q-err">${esc(j.error)}</div>` : j.status === 'cancelled' ? '' : `<div class="progress ${indet ? 'indeterminate' : ''} ${j.status === 'finished' ? 'done' : ''}"><div class="bar" style="width:${pct}%"></div></div>`}
      ${left || right ? `<div class="q-sub"><span>${esc(left)}</span><span>${esc(right)}</span></div>` : ''}
      ${j.status === 'finished' && expires != null ? `<div class="q-sub"><span>${esc(j.filename)}</span><span>${esc(t('q.expires', { m: localDigits(expires) }))}</span></div>` : ''}
      <div class="q-actions">${actions}</div>
    </div>`;
}

function renderQueue() {
  const panel = $('#queuePanel');
  const jobs = [...state.jobs.values()].sort((a, b) => b.created - a.created);
  if (!jobs.length && !state.pending.length) {
    panel.innerHTML = `<div class="drawer-empty"><div class="de-icon">${icon('download')}</div><b>${esc(t('q.emptyTitle'))}</b><p>${esc(t('q.empty'))}</p></div>`;
    return;
  }
  const finished = jobs.filter((j) => j.status === 'finished');
  const unsaved = finished.filter((j) => !state.jobMeta[j.id]?.saved);
  panel.innerHTML = `
    <div class="drawer-tools">
      <span>${esc(t('q.summary', { a: localDigits(jobs.filter((j) => ACTIVE.has(j.status)).length + state.pending.length), d: localDigits(finished.length) }))}</span>
      <span style="display:flex;gap:6px">
        ${unsaved.length > 1 ? `<button class="chip-btn" id="saveAll">${icon('save')}${esc(t('q.saveAll'))}</button>` : ''}
        <button class="chip-btn" id="clearDone">${icon('trash')}${esc(t('q.clear'))}</button>
      </span>
    </div>
    <div class="q-list">
      ${state.pending.map((p) => `<div class="q-item" data-pid="${p.cid}">
        <div class="q-thumb">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" onerror="this.remove()">` : icon('clock')}</div>
        <div class="q-body"><div class="q-title">${esc(p.title)}</div>
          <div class="q-meta"><span class="q-tag">${esc(p.body.label || p.body.quality)}</span><span class="q-stage">${esc(t('stage.waiting'))}</span></div>
          <div class="q-actions"><button class="chip-btn danger" data-pa="${p.cid}">${icon('x')}${esc(t('q.cancel'))}</button></div></div></div>`).join('')}
      ${jobs.map((j) => `<div class="q-item st-${j.status}" data-qid="${j.id}">${queueItemHtml(j)}</div>`).join('')}
    </div>`;
  $('#clearDone')?.addEventListener('click', () => {
    for (const j of [...state.jobs.values()]) if (!ACTIVE.has(j.status)) { state.jobs.delete(j.id); delete state.jobMeta[j.id]; }
    persistJobs(); renderQueue(); updateBadge();
  });
  $('#saveAll')?.addEventListener('click', async () => { for (const j of unsaved) { saveFile(j); await sleep(700); } renderQueue(); });
}

function renderQueueItem(j) {
  const el = document.querySelector(`[data-qid="${j.id}"]`);
  if (!el) return renderQueue();
  const wasFinal = !ACTIVE.has(j.status);
  el.className = `q-item st-${j.status}`;
  el.innerHTML = queueItemHtml(j);
  if (wasFinal) renderQueue();
}

function onQueueClick(e) {
  const btn = e.target.closest('[data-qa],[data-pa]');
  if (!btn) return;
  if (btn.dataset.pa) {
    state.pending = state.pending.filter((p) => p.cid !== btn.dataset.pa);
    renderQueue(); updateBadge(); updatePlaylistStates();
    return;
  }
  const id = btn.closest('[data-qid]')?.dataset.qid;
  const j = state.jobs.get(id);
  if (!j) return;
  const a = btn.dataset.qa;
  if (a === 'cancel') cancelJob(id);
  else if (a === 'remove') removeJob(id);
  else if (a === 'retry') retryJob(id);
  else if (a === 'save') { saveFile(j); renderQueue(); }
  else if (a === 'preview') {
    const src = `${j.file_url}?inline=1`;
    openModal(j.title, j.kind === 'audio' ? `<audio src="${esc(src)}" controls autoplay></audio>` : `<video src="${esc(src)}" controls autoplay playsinline></video>`);
  }
}

/* ------------------------------------------------------------------ history */
function addHistory(d, url) {
  const item = { url, title: d.title, platform: d.platform, thumb: d.thumbnail, type: d.type, ts: Date.now() };
  state.history = [item, ...state.history.filter((h) => h.url !== url)].slice(0, 40);
  store.set('history', state.history);
  renderHistory();
}
function renderHistory() {
  const panel = $('#historyPanel');
  if (!state.history.length) {
    panel.innerHTML = `<div class="drawer-empty"><div class="de-icon">${icon('clock')}</div><b>${esc(t('h.emptyTitle'))}</b><p>${esc(t('h.empty'))}</p></div>`;
    return;
  }
  panel.innerHTML = `
    <div class="drawer-tools"><span>${esc(t('h.count', { n: localDigits(state.history.length) }))}</span><button class="chip-btn" id="clearHist">${icon('trash')}${esc(t('h.clear'))}</button></div>
    <div class="q-list">${state.history.map((h, i) => `
      <div class="h-item" data-hi="${i}" role="button" tabindex="0">
        <div class="ht pf-${esc(h.platform)}">${h.thumb ? `<img src="${esc(h.thumb)}" alt="" onerror="this.remove()">` : ''}${h.thumb ? '' : brandIcon(h.platform)}</div>
        <div style="min-width:0"><b>${esc(h.title)}</b><small>${esc(pname(h.platform))}${h.type === 'playlist' ? ' · ' + esc(t('h.playlist')) : ''} · ${esc(timeAgo(h.ts))}</small></div>
        <span class="chip-btn">${icon('arrow-right')}</span>
      </div>`).join('')}</div>`;
  $('#clearHist').onclick = () => { state.history = []; store.set('history', []); renderHistory(); };
  $$('[data-hi]', panel).forEach((el) => el.addEventListener('click', () => {
    const h = state.history[+el.dataset.hi];
    closeDrawer();
    fetchInfo(h.url, { playlist: h.type === 'playlist' });
  }));
}

/* ------------------------------------------------------------------ settings */
function renderSettings() {
  const s = state.settings;
  const row = (key, title, desc) => `
    <div class="set-row"><div class="st"><b>${esc(title)}</b><small>${esc(desc)}</small></div>
    <label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span class="track"></span></label></div>`;
  const h = state.health;
  $('#settingsPanel').innerHTML = `
    <div class="settings">
      ${row('autoSave', t('s.autoSave'), t('s.autoSaveD'))}
      ${row('autoFetch', t('s.autoFetch'), t('s.autoFetchD'))}
      ${row('preferH264', t('s.h264'), t('s.h264D'))}
      ${row('notify', t('s.notify'), t('s.notifyD'))}
      <div class="set-row"><div class="st"><b>${esc(t('s.theme'))}</b><small>${esc(t('s.themeD'))}</small></div>
        <button class="chip-btn" id="setTheme">${icon(state.theme === 'dark' ? 'sun' : 'moon')}${esc(state.theme === 'dark' ? t('s.light') : t('s.dark'))}</button></div>
      <div class="set-row"><div class="st"><b>${esc(t('s.lang'))}</b><small>English / বাংলা</small></div>
        <button class="chip-btn" id="setLang">${icon('globe')}${state.lang === 'bn' ? 'English' : 'বাংলা'}</button></div>
      ${h ? `<div class="stats-mini">
        <div><b>${esc(localDigits(h.stats.completed))}</b><small>${esc(t('s.statDone'))}</small></div>
        <div><b>${esc(fmtBytes(h.stats.bytes))}</b><small>${esc(t('s.statData'))}</small></div>
        <div><b>${esc(localDigits((h.jobs.downloading || 0) + (h.jobs.processing || 0) + (h.jobs.queued || 0)))}</b><small>${esc(t('s.statActive'))}</small></div>
      </div>
      <p style="color:var(--muted);font-size:.78rem;margin:4px 2px">${esc(t('s.server', { v: h.version, y: h.yt_dlp, f: h.ffmpeg ? '✓' : '✗' }))}</p>` : ''}
      <button class="btn btn-ghost" id="resetAll" style="margin-top:6px">${icon('trash')}${esc(t('s.reset'))}</button>
    </div>`;
  $$('[data-set]').forEach((el) => el.addEventListener('change', async () => {
    const k = el.dataset.set;
    if (k === 'notify' && el.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission().catch(() => 'denied');
      if (perm !== 'granted') { el.checked = false; toast(t('err.notify'), 'err'); return; }
    }
    state.settings[k] = el.checked;
    store.set('settings', state.settings);
    if (k === 'preferH264' && $('#preferH264')) $('#preferH264').checked = el.checked;
  }));
  $('#setTheme').onclick = () => { applyTheme(state.theme === 'dark' ? 'light' : 'dark'); renderSettings(); };
  $('#setLang').onclick = () => setLang(state.lang === 'bn' ? 'en' : 'bn');
  $('#resetAll').onclick = () => {
    ['jobs', 'history', 'settings'].forEach((k) => localStorage.removeItem('mg.' + k));
    state.history = []; state.jobMeta = {}; state.jobs.clear(); state.pending = [];
    state.settings = { autoSave: true, autoFetch: true, notify: false, preferH264: true };
    renderQueue(); renderHistory(); renderSettings(); updateBadge();
    toast(t('toast.reset'), 'ok');
  };
}

async function refreshHealth() {
  try {
    state.health = await api('/api/health');
    $('#footerVersion').textContent = `v${state.health.version} · yt-dlp ${state.health.yt_dlp}`;
    if (!$('#settingsPanel').classList.contains('hidden')) renderSettings();
  } catch { /* offline */ }
}

/* ------------------------------------------------------------------ modal */
function openModal(title, mediaHtml) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box"><div class="modal-head"><b>${esc(title)}</b><button class="icon-btn" id="modalClose" aria-label="Close">${icon('x')}</button></div><div class="modal-media">${mediaHtml}</div></div>`;
  m.classList.remove('hidden');
  $('#modalClose').onclick = closeModal;
}
function closeModal() {
  const m = $('#modal');
  m.querySelectorAll('video,audio').forEach((v) => v.pause());
  m.innerHTML = '';
  m.classList.add('hidden');
}

/* ------------------------------------------------------------------ restore jobs after reload */
async function restoreJobs() {
  const ids = Object.keys(state.jobMeta).filter((id) => /^[a-f0-9]{16}$/.test(id));
  if (!ids.length) return;
  try {
    const res = await api('/api/jobs?ids=' + ids.join(','));
    res.jobs.forEach((j) => state.jobs.set(j.id, j));
    res.missing.forEach((id) => delete state.jobMeta[id]);
    persistJobs();
    renderQueue();
    updateBadge();
    ensurePolling();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ PWA */
function setupPWA() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#installBtn').classList.remove('hidden');
  });
  const install = async () => {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice.catch(() => {});
      state.installPrompt = null;
      $('#installBtn').classList.add('hidden');
    } else {
      toast(/iphone|ipad|ipod/i.test(navigator.userAgent) ? t('pwa.ios') : t('pwa.manual'), 'info', { timeout: 7000 });
    }
  };
  $('#installBtn').addEventListener('click', install);
  $('#installBtn2').addEventListener('click', install);
  window.addEventListener('appinstalled', () => toast(t('pwa.done'), 'ok'));
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  $('#urlForm').addEventListener('submit', (e) => { e.preventDefault(); fetchInfo(input().value); });
  input().addEventListener('input', updatePlatformBadge);
  input().addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    const url = extractUrl(text);
    if (url && state.settings.autoFetch) { e.preventDefault(); input().value = url; updatePlatformBadge(); fetchInfo(url); }
  });
  $('#clearBtn').addEventListener('click', () => { input().value = ''; updatePlatformBadge(); input().focus(); });
  $('#pasteBtn').addEventListener('click', pasteFromClipboard);
  $$('.mode-tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#batchInput').addEventListener('input', renderBatchCount);
  $('#batchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const urls = batchUrls();
    if (!urls.length) { toast(t('err.noLinks'), 'err'); return; }
    const [kind, quality] = $('#batchPreset').value.split(':');
    const label = quality === 'best' ? 'best' : (kind === 'video' ? `${quality}p` : quality.toUpperCase());
    urls.forEach((url) => enqueue({ url, kind, quality, label, options: { prefer_h264: state.settings.preferH264 } }));
    toast(t('toast.addedMany', { n: fmtNum(urls.length) }), 'ok');
    $('#batchInput').value = '';
    renderBatchCount();
    openDrawer('queue');
  });
  $('#platformChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    setMode('single');
    input().placeholder = t('input.placeholderP', { p: pname(chip.dataset.chip) });
    input().focus();
  });

  $('#themeBtn').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  $('#langBtn').addEventListener('click', () => setLang(state.lang === 'bn' ? 'en' : 'bn'));
  $('#queueBtn').addEventListener('click', () => openDrawer('queue'));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  $$('.drawer-tab').forEach((b) => b.addEventListener('click', () => switchDrawerTab(b.dataset.dtab)));
  $('#queuePanel').addEventListener('click', onQueueClick);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    try { await navigator.clipboard.writeText(c.dataset.copy); toast(t('toast.copied'), 'ok'); } catch { toast(c.dataset.copy, 'info'); }
  });

  // Paste anywhere on the page
  document.addEventListener('paste', (e) => {
    const tg = e.target;
    if (tg.closest && tg.closest('input, textarea, [contenteditable="true"]')) return;
    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    const url = extractUrl(text);
    if (!url) return;
    e.preventDefault();
    setMode('single', false);
    input().value = url;
    updatePlatformBadge();
    if (state.settings.autoFetch) fetchInfo(url);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeDrawer(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setMode('single'); input().select(); }
    if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); setMode('single'); input().focus(); }
  });

  // Drag & drop links
  let dragDepth = 0;
  const overlay = $('#dropOverlay');
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].some((x) => x === 'text/uri-list' || x === 'text/plain')) return;
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.add('hidden'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const url = extractUrl(text);
    if (url) fetchInfo(url); else toast(t('err.invalidUrl'), 'err');
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; poll(); } });
}

/* ------------------------------------------------------------------ init */
async function init() {
  hydrateIcons();
  applyTheme(state.theme);
  setLang(state.lang);
  bindEvents();
  setupPWA();
  startRotator();
  updatePlatformBadge();
  updateBadge();

  const bm = `javascript:(function(){window.open('${location.origin}/?url='+encodeURIComponent(location.href),'_blank');})();`;
  $('#bookmarklet').setAttribute('href', bm);

  api('/api/config').then((c) => { state.config = c; }).catch(() => {});
  refreshHealth();
  restoreJobs();

  // Share target / deep link: /?url=...  or  ?text=... (Android share sheet)
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (shared) {
    const url = extractUrl(shared);
    history.replaceState({}, '', location.pathname);
    if (url) fetchInfo(url);
  }
}

init();
