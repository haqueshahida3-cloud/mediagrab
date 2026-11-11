// MediaGrab downloader app (home page) — vanilla JS modules, no build step.
import {
  $, $$, esc, sleep, truncate, store, ui, t, STRINGS, locale, localDigits, fmtNum, fmtCompact, fmtBytes, fmtSpeed, fmtDur,
  fmtDate, timeAgo, applyI18n, setLang, onLang, extractUrl, detectPlatform, pname, api, toast, openModal, closeModal,
  modalOpen, icon, brandIcon, hydrateIcons, initChrome, showShortcuts, THEMES, ACCENTS, BACKGROUNDS, themePref, setTheme,
  accentKey, setAccent, bgPref, setBg, setBgImage, motionReduced, setMotion, saveUrl, PLATFORM_META,
} from './core.js';

const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'processing']);
const DEFAULT_SETTINGS = {
  autoSave: true, autoFetch: true, notify: false, preferH264: true, clipboard: false, parallel: 3, keepHistory: true, favorites: [],
};

const state = {
  mode: 'single',
  info: null,
  infoUrl: '',
  fetchToken: 0,
  jobs: new Map(),
  jobMeta: store.get('jobs', {}),
  pending: [],
  pendingMap: {},
  rowJobs: {},
  plMap: {},
  gsel: new Set(),
  history: store.get('history', []),
  recent: store.get('recent', []),
  settings: Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {})),
  config: null,
  health: null,
  pollTimer: null,
  clipLast: store.raw('clipLast') || '',
};
const maxParallel = () => Math.min(5, Math.max(1, +state.settings.parallel || 3));
const saveSettings = () => store.set('settings', state.settings);

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
    if (!el || document.hidden || motionReduced()) return;
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
  ['captions', 'f7'], ['skip', 'f8'], ['images', 'f9'], ['smartphone', 'f10'], ['globe', 'f11'], ['lock', 'f12'],
];
const PLATFORM_CARDS = ['youtube', 'facebook', 'instagram', 'twitter', 'tiktok'];
const orderedPlatforms = () => {
  const fav = state.settings.favorites || [];
  return [...fav.filter((p) => PLATFORM_CARDS.includes(p)), ...PLATFORM_CARDS.filter((p) => !fav.includes(p))];
};

function renderChips() {
  const fav = state.settings.favorites || [];
  $('#platformChips').innerHTML = orderedPlatforms().map((p) => `
    <button type="button" class="pchip ${fav.includes(p) ? 'is-fav' : ''}" data-chip="${p}"><span class="pdot pf-${p}">${brandIcon(p)}</span>${esc(pname(p))}<span class="fav" data-fav="${p}" role="button" aria-label="★ ${esc(pname(p))}" title="${esc(t('fav.hint'))}">★</span></button>`).join('')
    + `<a class="pchip more" href="/platforms">${esc(t('chips.more'))}</a>`;
}

function renderStatic() {
  renderChips();
  $('#featuresGrid').innerHTML = FEATURES.map(([ic, k]) => `
    <div class="feature"><div class="fi">${icon(ic)}</div><h3>${esc(t(k + '.t'))}</h3><p>${esc(t(k + '.d'))}</p></div>`).join('');
  $('#platformGrid').innerHTML = PLATFORM_CARDS.map((p) => `
    <div class="pcard"><div class="picon pf-${p}">${brandIcon(p)}</div><h3>${esc(pname(p))}</h3>
      <p>${esc(t('pc.' + p + '.d'))}</p>
      <div class="ptags">${t('pc.' + p + '.tags').split(',').map((x) => `<span>${esc(x.trim())}</span>`).join('')}</div></div>`).join('');
  const faqs = [];
  for (let i = 1; STRINGS.en['faq.q' + i] && faqs.length < 6; i++) faqs.push(i);
  $('#faqList').innerHTML = faqs.map((i) => `<details><summary>${esc(t('faq.q' + i))}</summary><div class="ans">${t('faq.a' + i)}</div></details>`).join('');
  if (state.health) $('#footerVersion').textContent = `v${state.health.version} · yt-dlp ${state.health.yt_dlp}`;
}

function toggleFavorite(p) {
  const fav = new Set(state.settings.favorites || []);
  fav.has(p) ? fav.delete(p) : fav.add(p);
  state.settings.favorites = [...fav];
  saveSettings();
  renderChips();
  if (!$('#settingsPanel').classList.contains('hidden')) renderSettings();
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
  $('#batchCount').textContent = t('batch.count', { n: fmtNum(batchUrls().length) });
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const url = extractUrl(text);
    if (!url) { toast(t('err.noLinkClipboard'), 'err'); return; }
    hideClipSuggest();
    if (state.mode === 'batch') { $('#batchInput').value += ($('#batchInput').value ? '\n' : '') + text.trim(); renderBatchCount(); return; }
    input().value = url;
    updatePlatformBadge();
    if (state.settings.autoFetch) fetchInfo(url);
  } catch {
    toast(t('err.clipboard'), 'info');
    input().focus();
  }
}

/* -------- clipboard detection (only with permission) */
async function clipboardPermission() {
  try { return (await navigator.permissions.query({ name: 'clipboard-read' })).state; } catch { return 'unknown'; }
}
async function checkClipboard() {
  if (!state.settings.clipboard || document.hidden || !navigator.clipboard?.readText) return;
  if ((await clipboardPermission()) !== 'granted') return;
  try {
    const url = extractUrl(await navigator.clipboard.readText());
    if (!url || url === state.clipLast || url === state.infoUrl || url === extractUrl(input().value)) return;
    showClipSuggest(url);
  } catch { /* page not focused */ }
}
function showClipSuggest(url) {
  const box = $('#clipSuggest');
  const p = detectPlatform(url);
  box.className = 'clip-suggest';
  box.innerHTML = `<span class="pdot pf-${p}">${brandIcon(p)}</span><b>${esc(t('clip.found'))}</b><span class="cs-url">${esc(url)}</span>
    <button type="button" class="btn btn-primary btn-xs" id="clipUse">${esc(t('clip.use'))}</button>
    <button type="button" class="icon-btn" id="clipNo" aria-label="${esc(t('clip.dismiss'))}">${icon('x')}</button>`;
  const remember = () => { state.clipLast = url; store.raw('clipLast', url); };
  $('#clipUse').onclick = () => { remember(); hideClipSuggest(); fetchInfo(url); };
  $('#clipNo').onclick = () => { remember(); hideClipSuggest(); };
}
function hideClipSuggest() { const b = $('#clipSuggest'); b.className = 'hidden'; b.innerHTML = ''; }

/* ------------------------------------------------------------------ fetch info */
function setLoading(on) {
  const b = $('#fetchBtn');
  b.classList.toggle('loading', on);
  b.disabled = on;
}

async function fetchInfo(raw, { playlist = false } = {}) {
  const url = extractUrl(raw);
  if (!url) { toast(t('err.invalidUrl'), 'err'); input().focus(); return; }
  setMode('single', false);
  hideClipSuggest();
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
    renderInfo(data);
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

function renderInfo(d, keep = false) {
  if (d.type === 'playlist') renderPlaylist(d, keep);
  else if (d.type === 'gallery') renderGallery(d, keep);
  else renderVideo(d, keep);
}

function scrollToResult(onlyIfHidden = false) {
  const el = $('#result');
  const navH = ($('.nav')?.offsetHeight || 64) + 14;
  const top = el.getBoundingClientRect().top;
  if (onlyIfHidden && top >= navH - 4 && top < window.innerHeight * 0.6) return;
  window.scrollTo({ top: Math.max(0, top + window.scrollY - navH), behavior: motionReduced() ? 'auto' : 'smooth' });
}

let skeletonTimer = null;
function renderSkeleton(platform, playlist) {
  clearInterval(skeletonTimer);
  const msgs = [t('load.connect', { p: pname(platform || 'other') }), t('load.reading'), playlist ? t('load.playlist') : t('load.formats'), t('load.almost')];
  $('#result').innerHTML = `
    <div class="card skeleton-card" aria-busy="true">
      <div class="rc-top">
        <div class="sk" style="aspect-ratio:16/9;border-radius:16px"></div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="sk" style="height:22px;width:120px;border-radius:99px"></div>
          <div class="sk" style="height:26px;width:85%"></div><div class="sk" style="height:26px;width:60%"></div>
          <div class="sk" style="height:18px;width:40%"></div>
          <div style="display:flex;gap:8px"><div class="sk" style="height:28px;width:90px;border-radius:99px"></div><div class="sk" style="height:28px;width:70px;border-radius:99px"></div><div class="sk" style="height:28px;width:110px;border-radius:99px"></div></div>
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
    <div class="card error-card" role="alert">
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

/* ------------------------------------------------------------------ shared result bits */
const stat = (ic, text) => `<span class="stat">${icon(ic)}${esc(text)}</span>`;
const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();
const MT_ICON = { video: 'film', audio: 'music', photo: 'image', carousel: 'images', album: 'images', mixed: 'layers', playlist: 'list' };
const mtBadge = (mt) => `<span class="mt-badge">${icon(MT_ICON[mt] || 'film')}${esc(t('mt.' + mt))}</span>`;

/* ------------------------------------------------------------------ single video / audio view */
function renderVideo(d, keepTab = false) {
  const prevTab = keepTab ? ($('.rc-tab.active')?.dataset.tab || 'video') : (d.video.length ? 'video' : 'audio');
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
    d.video.length ? ['video', 'film', t('tab.video'), d.video.length] : null,
    ['audio', 'music', t('tab.audio'), d.audio.length],
    ['thumbs', 'image', t('tab.thumbs'), d.thumbnails.length],
    d.subtitles.length ? ['subs', 'captions', t('tab.subs'), d.subtitles.length] : null,
    ['advanced', 'sliders', t('tab.advanced'), null],
  ].filter(Boolean);
  const maxMin = state.config?.max_duration_minutes;
  const best = first ? `${first.label}${first.original ? ` · ${first.original}` : ''}` : '';

  $('#result').innerHTML = `
  <article class="card result-card">
    <div class="rc-top">
      <div class="rc-thumb ${portrait ? 'portrait' : ''}" id="rcThumb" role="button" tabindex="0" aria-label="${esc(t('rc.preview'))}">
        ${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" decoding="async" data-fallback>` : ''}
        <div class="play"><span>${icon('play')}</span></div>
        ${d.duration ? `<span class="rc-duration">${fmtDur(d.duration)}</span>` : ''}
        <span class="rc-pf pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(pname(d.platform))}</span>
      </div>
      <div class="rc-meta">
        <div class="rc-kickers">${mtBadge(d.media_type || 'video')}${d.max_badge && d.video.length ? `<span class="q-badge q-${esc(d.max_badge)}">${esc(d.max_badge)}</span>` : ''}</div>
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
    ${d.video.length ? `<div class="rc-panel" data-panel="video">
      ${d.formats_hidden ? `<div class="max-note warn">${icon('alert')}<div>${esc(t('rc.hidden'))}</div></div>` : ''}
      ${best ? `<div class="max-note">${icon('info')}<div>${esc(t('rc.maxAvail', { q: localDigits(best) }))}${d.platform === 'youtube' && d.max_res && d.max_res < 2160 && !d.formats_hidden ? ' · ' + esc(t('rc.no4k', { q: localDigits(first.label) })) : ''}</div></div>` : ''}
      ${videoPanel(d)}</div>` : ''}
    <div class="rc-panel hidden" data-panel="audio">${d.media_type === 'audio' ? `<div class="max-note">${icon('music')}<div>${esc(t('rc.audioOnly'))}</div></div>` : ''}${audioPanel(d)}</div>
    <div class="rc-panel hidden" data-panel="thumbs">${thumbsPanel(d)}</div>
    ${d.subtitles.length ? `<div class="rc-panel hidden" data-panel="subs">${subsPanel(d)}</div>` : ''}
    <div class="rc-panel hidden" data-panel="advanced">${advancedPanel(d)}</div>
  </article>`;

  hydrateIcons($('#result'));
  switchTab(tabs.some((x) => x[0] === prevTab) ? prevTab : tabs[0][0]);
  if (prevAdv) writeAdvancedRaw(prevAdv);
  bindResult(d);
  updateAdvancedIndicator();
  updateRowButtons();
}

function dlButton(kind, quality, label, extra = '') {
  return `<button class="btn-dl" type="button" data-dl data-kind="${kind}" data-quality="${esc(quality)}" data-label="${esc(label)}" ${extra}>${icon('download')}<span>${esc(t('btn.download'))}</span></button>`;
}

function videoPanel(d) {
  if (!d.video.length) return `<div class="empty-note">${esc(t('rc.noVideo'))}</div>`;
  return `<div class="fmt-list">${d.video.map((v) => {
    const extra = [v.ext.toUpperCase(), (v.codecs && v.codecs.length > 1 ? v.codecs.join('/') : v.codec), v.fps && v.fps > 30 ? `${v.fps}fps` : ''].filter(Boolean).join(' · ');
    return `<div class="fmt-row">
      <span class="q-badge q-${v.badge}">${esc(v.badge)}</span>
      <div class="fmt-main"><b>${esc(v.label)}${v.hdr ? ' <span class="tag hdr">HDR</span>' : ''}${v === d.video[0] ? ` <span class="tag">${esc(t('rc.best'))}</span>` : ''}</b><small>${v.original ? `<span class="orig">${esc(t('rc.orig', { r: localDigits(v.original) }))}</span> · ` : ''}${esc(extra)}</small></div>
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
    <div class="thumb-card"><div class="ti"><img loading="lazy" decoding="async" src="${esc(th.url)}" alt="" data-fallback></div>
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
        <label class="field">${esc(t('adv.end'))}<input class="input" id="trimEnd" inputmode="numeric" placeholder="${d.duration ? asciiDigits(fmtDur(d.duration)) : '1:30'}"></label>
      </div>
      ${chapters.length ? `<select class="select" id="chapterSel" aria-label="${esc(t('adv.chapter'))}"><option value="">${esc(t('adv.chapter'))}</option>${chapters.map((c, i) => `<option value="${i}">${esc(fmtDur(c.start))} — ${esc(c.title)}</option>`).join('')}</select>` : ''}
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
      <select class="select" id="subLang" aria-label="${esc(t('adv.subs'))}">${subOpts}</select>
    </div>` : ''}
    <div class="adv-block">
      <h4>${icon('type')}${esc(t('adv.filename'))}</h4>
      <input class="input" id="customName" maxlength="140" placeholder="${esc(truncate(d.title, 60))}" aria-label="${esc(t('adv.filename'))}">
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
  $$('.rc-tab').forEach((b) => { b.classList.toggle('active', b.dataset.tab === id); b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
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
    $('#trimStart').value = asciiDigits(fmtDur(c.start));
    $('#trimEnd').value = c.end != null ? asciiDigits(fmtDur(c.end)) : '';
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
  if (job && (ACTIVE.has(job.status) || job.status === 'paused')) return openDrawer('queue');
  if (job && (job.status === 'error' || job.status === 'cancelled')) return retryJob(job.id);
  const d = state.info;
  const kind = btn.dataset.kind;
  let body;
  if (kind === 'gallery') {
    const items = btn.dataset.items ? btn.dataset.items.split(',').map(Number) : [];
    const it = items.length === 1 ? d.items.find((x) => x.index === items[0]) : null;
    body = { url: state.infoUrl, kind: 'gallery', items, title: d.title, thumbnail: it?.preview || d.thumbnail };
  } else {
    if (!validateAdvanced()) return;
    body = { url: state.infoUrl, kind, quality: btn.dataset.quality, label: btn.dataset.label, title: d?.title, thumbnail: d?.thumbnail, options: readAdvanced(kind) };
  }
  btn.disabled = true;
  try {
    const created = await submitJob(body);
    if (created) state.rowJobs[key] = created.id;
  } catch { /* toast shown */ } finally {
    btn.disabled = false;
    updateRowButtons();
  }
}

function updateRowButtons() {
  $$('[data-dl]').forEach((btn) => {
    const job = state.jobs.get(state.rowJobs[`${btn.dataset.kind}:${btn.dataset.quality}`]);
    btn.classList.remove('is-busy', 'is-done', 'is-error', 'indeterminate');
    btn.style.removeProperty('--p');
    const baseLabel = btn.dataset.text || t('btn.download');
    if (!job) { btn.innerHTML = `${icon(btn.dataset.icon || 'download')}<span>${esc(baseLabel)}</span>`; return; }
    if (job.status === 'finished') { btn.classList.add('is-done'); btn.innerHTML = `${icon('save')}<span>${esc(t('btn.saveFile'))}</span>`; return; }
    if (job.status === 'error' || job.status === 'cancelled') { btn.classList.add('is-error'); btn.innerHTML = `${icon('refresh')}<span>${esc(t('btn.retry'))}</span>`; return; }
    if (job.status === 'paused') { btn.innerHTML = `${icon('pause')}<span>${esc(t('stage.short.paused'))}</span>`; return; }
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
    const url = URL.createObjectURL(blob);
    saveUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(t('toast.subSaved'), 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ------------------------------------------------------------------ photo / carousel / album / mixed view */
function renderGallery(d, keep = false) {
  const visual = d.items.filter((i) => i.type !== 'audio');
  if (!keep) state.gsel = new Set(visual.map((i) => i.index));
  const sub = [
    d.uploader ? `<span>${icon('verified')} ${esc(d.uploader)}</span>` : '',
    d.upload_date ? `<span>${icon('calendar')} ${esc(fmtDate(d.upload_date))}</span>` : '',
    d.counts.image ? `<span>${icon('image')} ${esc(t('g.photos', { n: localDigits(d.counts.image) }))}</span>` : '',
    d.counts.video ? `<span>${icon('film')} ${esc(t('g.videos', { n: localDigits(d.counts.video) }))}</span>` : '',
    d.counts.audio ? `<span>${icon('music')} ${esc(t('g.sound'))}</span>` : '',
  ].filter(Boolean).join('');
  const note = d.note === 'partial' ? t('g.partial', { n: localDigits(d.counts.image), t: localDigits(d.total || '?') }) : d.note === 'preview_only' ? t('g.preview') : '';
  $('#result').innerHTML = `
  <article class="card gallery-card">
    <div class="g-head">
      <div class="g-cover">${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" decoding="async" data-fallback>` : ''}</div>
      <div style="min-width:0">
        <div class="rc-kickers">${mtBadge(d.media_type)}<span class="pl-kicker pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(pname(d.platform))}</span></div>
        <h2>${esc(d.title)}</h2>
        <div class="g-sub">${sub}</div>
      </div>
    </div>
    ${note ? `<div class="max-note warn" style="margin-top:14px">${icon('info')}<div>${esc(note)}</div></div>` : ''}
    ${visual.length > 1 ? `<div class="g-toolbar">
      <label class="check"><input type="checkbox" id="gAll" checked><span>${esc(t('g.selectAll'))}</span></label>
      <span class="muted" id="gCount"></span><span class="grow"></span>
      <button class="btn btn-ghost btn-sm" type="button" id="gSel">${icon('download')}<span id="gSelLabel"></span></button>
      ${dlButton('gallery', 'all', 'ZIP', 'data-items="" data-icon="archive" data-text="' + esc(t('g.dlAll')) + '" id="gZip"')}
    </div>` : ''}
    <div class="g-grid" id="gGrid" style="${visual.length > 1 ? '' : 'margin-top:16px'}">
      ${visual.map((it) => `
        <div class="g-item ${state.gsel.has(it.index) ? 'selected' : ''}" data-gi="${it.index}">
          ${visual.length > 1 ? `<label class="g-check" aria-label="${esc(t('g.of', { i: localDigits(it.index), n: localDigits(visual.length) }))}"><input type="checkbox" data-gsel="${it.index}" ${state.gsel.has(it.index) ? 'checked' : ''}>${icon('check')}</label>` : ''}
          ${visual.length > 1 ? `<span class="g-idx">${localDigits(it.index)}/${localDigits(visual.length)}</span>` : ''}
          <div class="g-media" data-view="${it.index}" role="button" tabindex="0" aria-label="${esc(t('g.view'))}">
            ${it.preview ? `<img loading="lazy" decoding="async" src="${esc(it.preview)}" alt="${esc(it.alt || '')}" data-fallback>` : icon(it.type === 'video' ? 'film' : 'image')}
            ${it.type === 'video' ? `<span class="g-type">${icon('play')}${it.duration ? fmtDur(it.duration) : esc(t('mt.video'))}</span>` : ''}
          </div>
          <div class="g-foot"><span>${esc(it.label ? localDigits(it.label) : (it.ext || '').toUpperCase())}${it.label && it.ext ? ' · ' + esc(it.ext.toUpperCase()) : ''}</span>
            ${dlButton('gallery', 'i' + it.index, it.type, `data-items="${it.index}"`)}</div>
        </div>`).join('')}
      ${d.items.filter((i) => i.type === 'audio').map((it) => `
        <div class="g-audio"><div class="ga-ic">${icon('music')}</div>
          <div class="grow" style="min-width:0"><b>${esc(it.title || t('g.audioTitle'))}</b><div class="muted" style="font-size:.82rem">${esc(t('g.audioTitle'))}${it.duration ? ' · ' + fmtDur(it.duration) : ''} · ${esc((it.ext || 'mp3').toUpperCase())}</div></div>
          ${dlButton('gallery', 'i' + it.index, 'audio', `data-items="${it.index}"`)}</div>`).join('')}
    </div>
    ${visual.length > 1 ? `<p class="muted" style="font-size:.8rem;margin:14px 2px 0">${icon('archive')} ${esc(t('g.zipNote'))}</p>` : ''}
  </article>`;
  bindGallery(d);
  updateGallerySel();
  updateRowButtons();
}

function updateGallerySel() {
  const d = state.info;
  if (!d || d.type !== 'gallery') return;
  const visual = d.items.filter((i) => i.type !== 'audio');
  const n = state.gsel.size;
  $$('.g-item').forEach((el) => el.classList.toggle('selected', state.gsel.has(+el.dataset.gi)));
  const all = $('#gAll');
  if (all) { all.checked = n === visual.length; all.indeterminate = n > 0 && n < visual.length; }
  $('#gCount') && ($('#gCount').textContent = t('g.selected', { n: localDigits(n) }));
  const selBtn = $('#gSel');
  if (selBtn) { $('#gSelLabel').textContent = t('g.dlSelected', { n: localDigits(n) }); selBtn.disabled = n === 0; }
}

function bindGallery(d) {
  const root = $('#result');
  $$('[data-dl]', root).forEach((btn) => btn.addEventListener('click', () => onRowDownload(btn)));
  root.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-gsel]');
    if (cb) { cb.checked ? state.gsel.add(+cb.dataset.gsel) : state.gsel.delete(+cb.dataset.gsel); updateGallerySel(); }
    if (e.target.id === 'gAll') {
      const visual = d.items.filter((i) => i.type !== 'audio');
      state.gsel = e.target.checked ? new Set(visual.map((i) => i.index)) : new Set();
      $$('[data-gsel]').forEach((x) => { x.checked = e.target.checked; });
      updateGallerySel();
    }
  });
  const view = (el) => openLightbox(d, +el.dataset.view);
  root.addEventListener('click', (e) => { const m = e.target.closest('[data-view]'); if (m) view(m); });
  root.addEventListener('keydown', (e) => { const m = e.target.closest('[data-view]'); if (m && e.key === 'Enter') view(m); });
  $('#gSel')?.addEventListener('click', async () => {
    const items = [...state.gsel].sort((a, b) => a - b);
    if (!items.length) return toast(t('g.noneSel'), 'err');
    const visual = d.items.filter((i) => i.type !== 'audio');
    const key = items.length === visual.length ? 'gallery:all' : `gallery:${items.length === 1 ? 'i' + items[0] : 'sel' + items.join('-')}`;
    const existing = state.jobs.get(state.rowJobs[key]);
    if (existing && existing.status === 'finished') return saveFile(existing);
    try {
      const job = await submitJob({ url: state.infoUrl, kind: 'gallery', items: items.length === visual.length ? [] : items, title: d.title, thumbnail: d.thumbnail });
      state.rowJobs[key] = job.id;
      updateRowButtons();
    } catch { /* toast shown */ }
  });
}

function openLightbox(d, index) {
  const visual = d.items.filter((i) => i.type !== 'audio');
  let pos = Math.max(0, visual.findIndex((i) => i.index === index));
  const draw = () => {
    const it = visual[pos];
    const media = it.type === 'image'
      ? `<img src="${esc(it.full || it.preview)}" alt="${esc(it.alt || '')}">`
      : `<div style="position:relative">${it.preview ? `<img src="${esc(it.preview)}" alt="">` : ''}<div class="max-note" style="margin-top:10px">${icon('film')}<div>${esc(t('mt.video'))}${it.duration ? ' · ' + fmtDur(it.duration) : ''}${it.label ? ' · ' + esc(it.label) : ''}</div></div></div>`;
    openModal(`${t('g.of', { i: localDigits(pos + 1), n: localDigits(visual.length) })} · ${truncate(d.title, 50)}`, `
      <div class="lightbox">${media}
        <div class="lb-nav">
          <button class="chip-btn" type="button" id="lbPrev" ${pos === 0 ? 'disabled' : ''}>${icon('chevron-left')}${esc(t('g.prev'))}</button>
          <span class="muted">${esc(it.label ? localDigits(it.label) : '')}${it.ext ? ' · ' + esc(it.ext.toUpperCase()) : ''}</span>
          <button class="chip-btn" type="button" id="lbNext" ${pos === visual.length - 1 ? 'disabled' : ''}>${esc(t('g.next'))}${icon('chevron-right')}</button>
          <button class="chip-btn primary" type="button" id="lbDl">${icon('download')}${esc(t('g.dlOne'))}</button>
        </div></div>`, {
      wide: true,
      onKey: (e) => {
        if (e.key === 'ArrowLeft' && pos > 0) { pos--; draw(); return true; }
        if (e.key === 'ArrowRight' && pos < visual.length - 1) { pos++; draw(); return true; }
        return false;
      },
    });
    $('#lbPrev')?.addEventListener('click', () => { if (pos > 0) { pos--; draw(); } });
    $('#lbNext')?.addEventListener('click', () => { if (pos < visual.length - 1) { pos++; draw(); } });
    $('#lbDl')?.addEventListener('click', () => {
      const btn = document.querySelector(`[data-dl][data-quality="i${it.index}"]`);
      closeModal();
      if (btn) onRowDownload(btn);
    });
  };
  draw();
}

/* ------------------------------------------------------------------ playlist view */
const PRESETS = [
  ['video:best', 'preset.vbest'], ['video:2160', 'preset.v2160'], ['video:1080', 'preset.v1080'], ['video:720', 'preset.v720'], ['video:480', 'preset.v480'], ['video:360', 'preset.v360'],
  ['audio:mp3-320', 'preset.mp3320'], ['audio:mp3-128', 'preset.mp3128'], ['audio:m4a', 'preset.m4a'],
];
function presetSelect(id, selected = 'video:720') {
  return `<select class="select" id="${id}" aria-label="Format">${PRESETS.map(([v, k]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>`;
}

function renderPlaylist(d, keep = false) {
  const prevChecked = keep ? new Set($$('.pl-check:checked').map((c) => +c.dataset.idx)) : null;
  const prevPreset = keep ? $('#plPreset')?.value : null;
  $('#result').innerHTML = `
  <article class="card pl-card">
    <div class="pl-head">
      <div class="ph">${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" data-fallback>` : ''}</div>
      <div style="min-width:0">
        <div class="rc-kickers">${mtBadge('playlist')}<span class="pl-kicker pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(t('pl.kicker', { p: pname(d.platform) }))}</span></div>
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
        <div class="pt">${e.thumbnail ? `<img loading="lazy" decoding="async" src="${esc(e.thumbnail)}" alt="" data-fallback>` : ''}${e.duration ? `<span>${fmtDur(e.duration)}</span>` : ''}</div>
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
      state.plMap[e.index] = enqueue(body);
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
    const realId = state.pendingMap[ref] || ref;
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
      if (active >= maxParallel()) break;
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
      res.missing.forEach((id) => { const j = state.jobs.get(id); if (j) onJobUpdate({ ...j, status: 'error', stage: 'error', error: t('err.expired'), error_code: 'expired', retryable: true }); });
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
  addRecent(j);
  if (state.settings.autoSave && !meta.saved) saveFile(j, true);
  else toast(t('toast.ready', { t: truncate(j.title, 40) }), 'ok', { action: t('btn.saveFile'), onAction: () => saveFile(j) });
  if (state.settings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(t('toast.readyTitle'), { body: j.title, icon: '/static/icons/icon-192.png' }); } catch { /* ignore */ }
  }
}

function saveFile(j, auto = false) {
  if (!j?.file_url) return;
  saveUrl(j.file_url, j.filename || '');
  const meta = state.jobMeta[j.id] || (state.jobMeta[j.id] = { created: Date.now() });
  meta.saved = true;
  persistJobs();
  toast(auto ? t('toast.autoSaved', { t: truncate(j.title, 40) }) : t('toast.saving'), 'ok');
}

async function jobAction(id, action) {
  try {
    const j = await api(`/api/jobs/${id}/${action}`, { method: 'POST' });
    onJobUpdate(j);
    if (action === 'pause') toast(t('toast.paused'), 'info', { timeout: 1800 });
    if (action === 'resume' || action === 'retry') ensurePolling();
    if (action === 'resume') toast(t('toast.resumed'), 'ok', { timeout: 1800 });
    // a pause request is acknowledged right away but takes effect within a second
    if (action === 'pause') setTimeout(async () => { try { onJobUpdate(await api(`/api/jobs/${id}`)); } catch { /* gone */ } }, 1200);
    return j;
  } catch (e) {
    if (e.status === 404 && action === 'retry') return resubmit(id);
    toast(e.message, 'err');
    return null;
  }
}
const cancelJob = (id) => jobAction(id, 'cancel');
const pauseJob = (id) => jobAction(id, 'pause');
const resumeJob = (id) => jobAction(id, 'resume');
const retryJob = (id) => jobAction(id, 'retry');

function resubmit(id) {
  const meta = state.jobMeta[id];
  const j = state.jobs.get(id);
  const body = meta?.req || (j && { url: j.url, kind: j.kind, quality: j.quality, label: j.label, title: j.title, thumbnail: j.thumbnail });
  if (!body) return null;
  state.jobs.delete(id);
  delete state.jobMeta[id];
  return submitJob(body).then((nj) => {
    for (const [k, v] of Object.entries(state.rowJobs)) if (v === id) state.rowJobs[k] = nj.id;
    for (const [k, v] of Object.entries(state.plMap)) if (v === id || state.pendingMap[v] === id) state.plMap[k] = nj.id;
    updateRowButtons();
    updatePlaylistStates();
    renderQueue();
    return nj;
  }).catch(() => { renderQueue(); return null; });
}

async function removeJob(id) {
  api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  state.jobs.delete(id);
  delete state.jobMeta[id];
  persistJobs();
  renderQueue();
  updateBadge();
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
  if (motionReduced()) return;
  $('#queueBtn').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'ease-out' });
}

/* ------------------------------------------------------------------ drawer: download manager */
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
const drawerOpen = () => $('#drawer').classList.contains('open');
function switchDrawerTab(tab) {
  $$('.drawer-tab').forEach((b) => b.classList.toggle('active', b.dataset.dtab === tab));
  $$('[data-dpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.dpanel !== tab));
  if (tab === 'settings') { renderSettings(); refreshHealth(); }
  if (tab === 'history') renderHistory();
}

function stageText(j) {
  if (j.status === 'queued') return j.queue_position ? t('q.position', { n: localDigits(j.queue_position) }) : t('stage.queued');
  if (j.status === 'finished') return `${t('stage.finished')} · ${fmtBytes(j.filesize)}`;
  if (j.status === 'error') return t('stage.error');
  if (j.status === 'paused') return t('stage.paused');
  return t('stage.' + (j.stage || j.status));
}

function mediaChips(j) {
  const m = j.media || {};
  const chips = [];
  if (j.kind === 'gallery') {
    if (m.items > 1) chips.push(`<span class="hi">${esc(t('q.files', { n: localDigits(m.items) }))}</span>`);
    if (m.width) chips.push(`<span class="hi">${esc(localDigits(`${m.width}×${m.height}`))}</span>`, `<span>${esc(m.format || '')}</span>`);
  } else if (m.width) {
    chips.push(`<span class="hi">${esc(localDigits(`${m.res}p`))}</span>`, `<span>${esc(localDigits(`${m.width}×${m.height}`))}</span>`);
    if (m.vcodec) chips.push(`<span>${esc(m.vcodec)}</span>`);
    if (m.fps) chips.push(`<span>${esc(localDigits(Math.round(m.fps)))}fps</span>`);
    if (m.hdr) chips.push('<span>HDR</span>');
  }
  if (m.acodec && j.kind !== 'gallery') chips.push(`<span>${esc(m.acodec)}${m.audio_bitrate ? ' ' + localDigits(Math.round(m.audio_bitrate / 1000)) + 'k' : ''}</span>`);
  if (m.container && j.kind !== 'gallery') chips.push(`<span>${esc(m.container.toUpperCase().replace('MOV', 'MP4'))}</span>`);
  return chips.length ? `<div class="q-media" title="${esc(t('q.output'))}">${chips.join('')}</div>` : '';
}

function queueItemHtml(j) {
  const kindIcon = j.kind === 'audio' ? 'music' : j.kind === 'gallery' ? 'images' : 'film';
  const running = j.status === 'downloading' || j.status === 'preparing' || j.status === 'processing';
  const indet = (j.status !== 'downloading' && j.status !== 'finished' && j.status !== 'paused') || (j.status === 'downloading' && !j.progress);
  const pct = j.status === 'finished' ? 100 : j.progress || 0;
  const left = (j.status === 'downloading' || j.status === 'paused') && (j.downloaded || pct)
    ? `${localDigits(Math.floor(pct))}%${j.downloaded ? ' · ' + fmtBytes(j.downloaded) : ''}${j.total ? ' / ' + fmtBytes(j.total) : ''}` : '';
  const right = j.status === 'downloading' ? [fmtSpeed(j.speed), j.eta != null ? t('q.eta', { t: fmtDur(j.eta) }) : ''].filter(Boolean).join(' · ') : '';
  const expires = j.expires ? Math.max(0, Math.round((j.expires * 1000 - Date.now()) / 60000)) : null;
  let actions = '';
  if (j.pausable && running) actions += `<button class="chip-btn" data-qa="pause">${icon('pause')}${esc(t('q.pause'))}</button>`;
  if (j.status === 'paused') actions += `<button class="chip-btn primary" data-qa="resume">${icon('play')}${esc(t('q.resume'))}</button>`;
  if (ACTIVE.has(j.status) || j.status === 'paused') actions += `<button class="chip-btn danger" data-qa="cancel">${icon('x')}${esc(t('q.cancel'))}</button>`;
  else if (j.status === 'finished') actions += `<button class="chip-btn primary" data-qa="save">${icon('save')}${esc(t('btn.saveFile'))}</button>${j.kind !== 'gallery' ? `<button class="chip-btn" data-qa="preview">${icon('play')}${esc(t('q.preview'))}</button>` : ''}<button class="chip-btn danger" data-qa="remove" aria-label="Remove">${icon('trash')}</button>`;
  else actions += `<button class="chip-btn" data-qa="retry">${icon('refresh')}${esc(t('btn.retry'))}</button><button class="chip-btn danger" data-qa="remove" aria-label="Remove">${icon('trash')}</button>`;
  return `
    <div class="q-thumb">${j.thumbnail ? `<img src="${esc(j.thumbnail)}" alt="" loading="lazy" data-fallback>` : icon(kindIcon)}<span class="qk pf-${esc(j.platform)}">${brandIcon(j.platform)}</span></div>
    <div class="q-body">
      <div class="q-title" title="${esc(j.title || j.url)}">${esc(j.title || j.url)}</div>
      <div class="q-meta"><span class="q-tag">${esc(j.label || j.quality)}</span><span class="q-stage ${j.status === 'finished' ? 'ok' : j.status === 'error' ? 'err' : ''}"><span class="st-dot"></span>${esc(stageText(j))}</span></div>
      ${j.status === 'error' ? `<div class="q-err">${esc(j.error)}</div>` : j.status === 'cancelled' ? '' : `<div class="progress ${indet ? 'indeterminate' : ''} ${j.status === 'finished' ? 'done' : ''}"><div class="bar" style="width:${pct}%"></div></div>`}
      ${left || right ? `<div class="q-sub"><span>${esc(left)}</span><span>${esc(right)}</span></div>` : ''}
      ${j.status === 'paused' ? `<div class="q-sub"><span>${esc(t('q.pausedNote'))}</span></div>` : ''}
      ${j.status === 'finished' ? mediaChips(j) : ''}
      ${j.warning ? `<div class="q-warn">${icon('alert')} ${esc(j.warning)}</div>` : ''}
      ${j.status === 'finished' && expires != null ? `<div class="q-sub"><span>${esc(j.filename)}</span><span>${esc(t('q.expires', { m: localDigits(expires) }))}</span></div>` : ''}
      <div class="q-actions">${actions}</div>
    </div>`;
}

const renderedIds = new Set();  // only newly added items animate in (no flicker on re-render)
function renderQueue() {
  const panel = $('#queuePanel');
  const jobs = [...state.jobs.values()].sort((a, b) => b.created - a.created);
  if (!jobs.length && !state.pending.length) {
    panel.innerHTML = `<div class="drawer-empty"><div class="de-icon">${icon('download')}</div><b>${esc(t('q.emptyTitle'))}</b><p>${esc(t('q.empty'))}</p></div>`;
    return;
  }
  const finished = jobs.filter((j) => j.status === 'finished');
  const unsaved = finished.filter((j) => !state.jobMeta[j.id]?.saved);
  const pausable = jobs.filter((j) => j.pausable && j.status !== 'queued');
  const paused = jobs.filter((j) => j.status === 'paused');
  const failed = jobs.filter((j) => j.status === 'error' || j.status === 'cancelled');
  panel.innerHTML = `
    <div class="drawer-tools">
      <span>${esc(t('q.summary', { a: localDigits(jobs.filter((j) => ACTIVE.has(j.status)).length + state.pending.length), d: localDigits(finished.length) }))}</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${pausable.length > 1 ? `<button class="chip-btn" id="pauseAll">${icon('pause')}${esc(t('q.ctrlAll'))}</button>` : ''}
        ${paused.length > 1 ? `<button class="chip-btn" id="resumeAll">${icon('play')}${esc(t('q.resumeAll'))}</button>` : ''}
        ${failed.length > 1 ? `<button class="chip-btn" id="retryAll">${icon('refresh')}${esc(t('q.retryAll'))}</button>` : ''}
        ${unsaved.length > 1 ? `<button class="chip-btn" id="saveAll">${icon('save')}${esc(t('q.saveAll'))}</button>` : ''}
        <button class="chip-btn" id="clearDone">${icon('trash')}${esc(t('q.clear'))}</button>
      </span>
    </div>
    <p class="muted" style="font-size:.76rem;margin:0 2px 10px">${esc(t('q.parallelInfo', { n: localDigits(maxParallel()) }))}</p>
    <div class="q-list">
      ${state.pending.map((p) => `<div class="q-item st-queued" data-pid="${p.cid}">
        <div class="q-thumb">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" data-fallback>` : icon('clock')}</div>
        <div class="q-body"><div class="q-title">${esc(p.title)}</div>
          <div class="q-meta"><span class="q-tag">${esc(p.body.label || p.body.quality)}</span><span class="q-stage"><span class="st-dot"></span>${esc(t('stage.waiting'))}</span></div>
          <div class="q-actions"><button class="chip-btn danger" data-pa="${p.cid}">${icon('x')}${esc(t('q.cancel'))}</button></div></div></div>`).join('')}
      ${jobs.map((j) => `<div class="q-item st-${j.status}${renderedIds.has(j.id) ? '' : ' enter'}" data-qid="${j.id}">${queueItemHtml(j)}</div>`).join('')}
    </div>`;
  jobs.forEach((j) => renderedIds.add(j.id));
  $('#clearDone')?.addEventListener('click', () => {
    for (const j of [...state.jobs.values()]) if (!ACTIVE.has(j.status) && j.status !== 'paused') { state.jobs.delete(j.id); delete state.jobMeta[j.id]; }
    persistJobs(); renderQueue(); updateBadge();
  });
  $('#saveAll')?.addEventListener('click', async () => { for (const j of unsaved) { saveFile(j); await sleep(700); } renderQueue(); });
  $('#pauseAll')?.addEventListener('click', () => pausable.forEach((j) => pauseJob(j.id)));
  $('#resumeAll')?.addEventListener('click', () => paused.forEach((j) => resumeJob(j.id)));
  $('#retryAll')?.addEventListener('click', () => failed.forEach((j) => retryJob(j.id)));
}

function renderQueueItem(j) {
  const el = document.querySelector(`[data-qid="${j.id}"]`);
  if (!el) return renderQueue();
  const cls = `q-item st-${j.status}`;
  const statusChanged = !el.classList.contains(`st-${j.status}`);
  el.className = cls;
  el.innerHTML = queueItemHtml(j);
  if (statusChanged && !ACTIVE.has(j.status)) renderQueue();
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
  else if (a === 'pause') pauseJob(id);
  else if (a === 'resume') resumeJob(id);
  else if (a === 'remove') removeJob(id);
  else if (a === 'retry') retryJob(id);
  else if (a === 'save') { saveFile(j); renderQueue(); }
  else if (a === 'preview') {
    const src = `${j.file_url}?inline=1`;
    openModal(j.title, j.kind === 'audio' ? `<audio src="${esc(src)}" controls autoplay></audio>` : `<video src="${esc(src)}" controls autoplay playsinline></video>`, { wide: true });
  }
}

/* ------------------------------------------------------------------ history: recent files + opened links */
function addHistory(d, url) {
  if (!state.settings.keepHistory) return;
  const item = { url, title: d.title, platform: d.platform, thumb: d.thumbnail, type: d.type, mt: d.media_type, ts: Date.now() };
  state.history = [item, ...state.history.filter((h) => h.url !== url)].slice(0, 40);
  store.set('history', state.history);
}
function addRecent(j) {
  if (!state.settings.keepHistory) return;
  const req = state.jobMeta[j.id]?.req;
  const item = { id: j.id, title: j.title, platform: j.platform, kind: j.kind, label: j.label, filename: j.filename, size: j.filesize,
    thumb: j.thumbnail, ts: Date.now(), expires: j.expires ? j.expires * 1000 : null, req };
  state.recent = [item, ...state.recent.filter((r) => r.id !== j.id)].slice(0, 50);
  store.set('recent', state.recent);
}
function renderHistory() {
  const panel = $('#historyPanel');
  if (!state.history.length && !state.recent.length) {
    panel.innerHTML = `<div class="drawer-empty"><div class="de-icon">${icon('clock')}</div><b>${esc(t('h.emptyTitle'))}</b><p>${esc(t('h.empty'))}</p></div>`;
    return;
  }
  const now = Date.now();
  panel.innerHTML = `
    <div class="drawer-tools"><span>${esc(t('h.recent'))}</span>${state.recent.length ? `<button class="chip-btn" id="clearRecent">${icon('trash')}${esc(t('h.clearRecent'))}</button>` : ''}</div>
    <div class="q-list recent-list">${state.recent.length ? state.recent.map((r, i) => {
      const live = r.expires && r.expires > now && state.jobs.get(r.id)?.status === 'finished';
      return `<div class="h-item" data-ri="${i}">
        <div class="ht pf-${esc(r.platform)}">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy" data-fallback>` : brandIcon(r.platform)}</div>
        <div style="min-width:0"><b>${esc(r.filename || r.title)}</b><small>${esc(r.label || '')} · ${esc(fmtBytes(r.size))} · ${esc(timeAgo(r.ts))}${live ? '' : ' · ' + esc(t('h.expired'))}</small></div>
        <button class="chip-btn ${live ? 'primary' : ''}" type="button" data-rsave="${i}">${icon(live ? 'save' : 'refresh')}${esc(live ? t('h.saveAgain') : t('h.again'))}</button>
      </div>`;
    }).join('') : `<p class="muted" style="font-size:.84rem;margin:4px 2px 12px">${esc(t('h.recentEmpty'))}</p>`}</div>
    <div class="drawer-tools" style="margin-top:14px"><span>${esc(t('h.links'))} · ${esc(localDigits(state.history.length))}</span>${state.history.length ? `<button class="chip-btn" id="clearHist">${icon('trash')}${esc(t('h.clear'))}</button>` : ''}</div>
    <div class="q-list">${state.history.map((h, i) => `
      <div class="h-item" data-hi="${i}" role="button" tabindex="0">
        <div class="ht pf-${esc(h.platform)}">${h.thumb ? `<img src="${esc(h.thumb)}" alt="" loading="lazy" data-fallback>` : brandIcon(h.platform)}</div>
        <div style="min-width:0"><b>${esc(h.title)}</b><small>${esc(pname(h.platform))}${h.mt ? ' · ' + esc(t('mt.' + h.mt)) : ''} · ${esc(timeAgo(h.ts))}</small></div>
        <span class="chip-btn">${icon('arrow-right')}</span>
      </div>`).join('')}</div>`;
  $('#clearHist')?.addEventListener('click', () => { state.history = []; store.set('history', []); renderHistory(); });
  $('#clearRecent')?.addEventListener('click', () => { state.recent = []; store.set('recent', []); renderHistory(); });
  $$('[data-hi]', panel).forEach((el) => {
    const go = () => { const h = state.history[+el.dataset.hi]; closeDrawer(); fetchInfo(h.url, { playlist: h.type === 'playlist' }); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  $$('[data-rsave]', panel).forEach((b) => b.addEventListener('click', () => {
    const r = state.recent[+b.dataset.rsave];
    const j = state.jobs.get(r.id);
    if (j && j.status === 'finished' && r.expires > Date.now()) return saveFile(j);
    if (r.req) submitJob(r.req).then(() => openDrawer('queue')).catch(() => {});
  }));
}

/* ------------------------------------------------------------------ settings */
function renderSettings() {
  const s = state.settings;
  const row = (key, title, desc) => `
    <div class="set-row"><div class="st"><b>${esc(title)}</b><small>${esc(desc)}</small></div>
    <label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span class="track"></span></label></div>`;
  const h = state.health;
  const pref = themePref(), ak = accentKey(), bg = bgPref();
  $('#settingsPanel').innerHTML = `
    <div class="settings">
      <div class="set-section">${esc(t('s.secDownloads'))}</div>
      ${row('autoSave', t('s.autoSave'), t('s.autoSaveD'))}
      ${row('autoFetch', t('s.autoFetch'), t('s.autoFetchD'))}
      ${row('preferH264', t('s.h264'), t('s.h264D'))}
      ${row('clipboard', t('s.clipboard'), t('s.clipboardD'))}
      ${row('notify', t('s.notify'), t('s.notifyD'))}
      <div class="set-row"><div class="st"><b>${esc(t('s.parallel'))}</b><small>${esc(t('s.parallelD'))}</small></div>
        <select class="select" id="setParallel" style="width:auto" aria-label="${esc(t('s.parallel'))}">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === maxParallel() ? 'selected' : ''}>${localDigits(n)}</option>`).join('')}</select></div>

      <div class="set-section">${esc(t('s.secAppearance'))}</div>
      <div class="theme-opts">${THEMES.map((k) => `<button type="button" class="theme-opt ${k === pref ? 'on' : ''}" data-st-theme="${k}" aria-pressed="${k === pref}"><span class="sw sw-${k}"></span>${esc(t('theme.' + k))}</button>`).join('')}</div>
      <div class="set-row" style="flex-wrap:wrap"><div class="st"><b>${esc(t('theme.accent'))}</b></div>
        <div class="swatches">${Object.entries(ACCENTS).map(([k, c]) => `<button type="button" class="swatch ${k === ak ? 'on' : ''}" title="${esc(t('acc.' + k))}" aria-label="${esc(t('acc.' + k))}" data-st-accent="${k}" style="background:linear-gradient(135deg,${c[0]},${c[1]},${c[2]})"></button>`).join('')}
          <label class="swatch custom ${ak === 'custom' ? 'on' : ''}" title="${esc(t('theme.custom'))}"><input type="color" id="setAccentCustom" value="${esc(store.raw('accentCustom') || '#8b5cf6')}" aria-label="${esc(t('theme.custom'))}"></label></div></div>
      <div class="set-row" style="flex-wrap:wrap"><div class="st"><b>${esc(t('theme.bg'))}</b><small>${esc(bg === 'image' ? t('bg.pick') : '')}</small></div>
        <div class="fav-list">${BACKGROUNDS.map((k) => `<button type="button" class="chip-btn ${k === bg ? 'active' : ''}" data-st-bg="${k}">${esc(t('bg.' + k))}</button>`).join('')}</div>
        <input type="file" accept="image/*" id="setBgFile" hidden></div>
      <div class="set-row"><div class="st"><b>${esc(t('theme.motion'))}</b><small>${esc(t('theme.motionD'))}</small></div>
        <label class="switch"><input type="checkbox" id="setMotion" ${motionReduced() ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="set-row"><div class="st"><b>${esc(t('s.lang'))}</b><small>English / বাংলা</small></div>
        <button class="chip-btn" id="setLang">${icon('globe')}${ui.lang === 'bn' ? 'English' : 'বাংলা'}</button></div>

      <div class="set-section">${esc(t('fav.title'))}</div>
      <p class="muted" style="font-size:.8rem;margin:0 2px 8px">${esc(t('fav.hint'))}</p>
      <div class="fav-list">${PLATFORM_CARDS.map((p) => `<button type="button" class="pchip ${(s.favorites || []).includes(p) ? 'is-fav' : ''}" data-st-fav="${p}"><span class="pdot pf-${p}">${brandIcon(p)}</span>${esc(pname(p))}<span class="fav">★</span></button>`).join('')}</div>

      <div class="set-section">${esc(t('s.secPrivacy'))}</div>
      ${row('keepHistory', t('s.historyKeep'), t('s.historyKeepD'))}
      <button class="btn btn-ghost" id="resetAll" style="margin-top:6px">${icon('trash')}${esc(t('s.reset'))}</button>

      <div class="set-section">${esc(t('s.secHelp'))}</div>
      <div class="set-row"><div class="st"><b>${esc(t('s.shortcuts'))}</b><small>${esc(t('s.shortcutsD'))}</small></div>
        <button class="chip-btn" id="setKeys">${icon('keyboard')}${esc(t('s.open'))}</button></div>
      ${h ? `<div class="stats-mini">
        <div><b>${esc(localDigits(h.stats.completed))}</b><small>${esc(t('s.statDone'))}</small></div>
        <div><b>${esc(fmtBytes(h.stats.bytes))}</b><small>${esc(t('s.statData'))}</small></div>
        <div><b>${esc(localDigits((h.jobs.downloading || 0) + (h.jobs.processing || 0) + (h.jobs.queued || 0)))}</b><small>${esc(t('s.statActive'))}</small></div>
      </div>
      <p style="color:var(--muted);font-size:.78rem;margin:4px 2px">${esc(t('s.server', { v: h.version, y: h.yt_dlp, f: h.ffmpeg ? '✓' : '✗' }))}</p>` : ''}
    </div>`;
  const panel = $('#settingsPanel');
  $$('[data-set]', panel).forEach((el) => el.addEventListener('change', async () => {
    const k = el.dataset.set;
    if (k === 'notify' && el.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission().catch(() => 'denied');
      if (perm !== 'granted') { el.checked = false; toast(t('err.notify'), 'err'); return; }
    }
    if (k === 'clipboard' && el.checked) {
      try { await navigator.clipboard.readText(); } catch { el.checked = false; toast(t('err.clipDenied'), 'err'); return; }
    }
    state.settings[k] = el.checked;
    saveSettings();
    if (k === 'preferH264' && $('#preferH264')) $('#preferH264').checked = el.checked;
  }));
  $('#setParallel').addEventListener('change', (e) => { state.settings.parallel = +e.target.value; saveSettings(); pumpPending(); });
  $('#setAccentCustom').addEventListener('input', (e) => setAccent(e.target.value));
  $('#setAccentCustom').addEventListener('change', () => renderSettings());
  $('#setBgFile').addEventListener('change', async (e) => { if (e.target.files[0]) { await setBgImage(e.target.files[0]); renderSettings(); } });
  $('#setMotion').addEventListener('change', (e) => setMotion(e.target.checked));
  $('#setLang').onclick = () => setLang(ui.lang === 'bn' ? 'en' : 'bn');
  $('#setKeys').onclick = showShortcuts;
  $('#resetAll').onclick = () => {
    ['jobs', 'history', 'recent', 'settings', 'clipLast'].forEach((k) => localStorage.removeItem('mg.' + k));
    state.history = []; state.recent = []; state.jobMeta = {}; state.jobs.clear(); state.pending = [];
    state.settings = { ...DEFAULT_SETTINGS };
    renderQueue(); renderHistory(); renderSettings(); updateBadge(); renderChips();
    toast(t('toast.reset'), 'ok');
  };
}

async function onSettingsClick(e) {
  const th = e.target.closest('[data-st-theme]'), ac = e.target.closest('[data-st-accent]'), bgb = e.target.closest('[data-st-bg]'), fv = e.target.closest('[data-st-fav]');
  if (th) { setTheme(th.dataset.stTheme); renderSettings(); }
  else if (ac) { setAccent(ac.dataset.stAccent); renderSettings(); }
  else if (bgb) { if (bgb.dataset.stBg === 'image') $('#setBgFile').click(); else { await setBg(bgb.dataset.stBg); renderSettings(); } }
  else if (fv) toggleFavorite(fv.dataset.stFav);
}

async function refreshHealth() {
  try {
    state.health = await api('/api/health');
    $('#footerVersion').textContent = `v${state.health.version} · yt-dlp ${state.health.yt_dlp}`;
    if (!$('#settingsPanel').classList.contains('hidden')) renderSettings();
  } catch { /* offline */ }
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

/* ------------------------------------------------------------------ events */
function onKey(e) {
  const k = e.key.toLowerCase();
  if (k === 'd') { drawerOpen() && $('.drawer-tab.active')?.dataset.dtab === 'queue' ? closeDrawer() : openDrawer('queue'); return true; }
  if (k === 'h') { openDrawer('history'); return true; }
  if (k === 's') { openDrawer('settings'); return true; }
  if (k === 'a' && state.info?.type === 'gallery' && $('#gAll')) { $('#gAll').click(); return true; }
  if (e.key === '/') { e.preventDefault(); setMode('single'); input().focus(); return true; }
  return false;
}

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
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); e.stopPropagation(); toggleFavorite(fav.dataset.fav); return; }
    const chip = e.target.closest('[data-chip]');
    if (!chip) return;
    setMode('single');
    input().placeholder = t('input.placeholderP', { p: pname(chip.dataset.chip) });
    input().focus();
  });

  $('#queueBtn').addEventListener('click', () => openDrawer('queue'));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#backdrop').addEventListener('click', closeDrawer);
  $$('.drawer-tab').forEach((b) => b.addEventListener('click', () => switchDrawerTab(b.dataset.dtab)));
  $('#queuePanel').addEventListener('click', onQueueClick);
  $('#settingsPanel').addEventListener('click', onSettingsClick);

  document.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    try { await navigator.clipboard.writeText(c.dataset.copy); toast(t('toast.copied'), 'ok'); } catch { toast(c.dataset.copy, 'info'); }
  });

  // paste anywhere on the page
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setMode('single'); input().select(); }
  });

  // drag & drop links
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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; poll(); }
      checkClipboard();
    }
  });
  window.addEventListener('focus', checkClipboard);
}

/* ------------------------------------------------------------------ init */
function rerenderForLang() {
  renderHeroTitle();
  renderStatic();
  renderBatchCount();
  if (state.info) renderInfo(state.info, true);
  renderQueue();
  if (!$('#historyPanel').classList.contains('hidden')) renderHistory();
  if (!$('#settingsPanel').classList.contains('hidden')) renderSettings();
}

async function init() {
  initChrome({ spa: true, onKey });
  // honour the language stored on this device (the server may have rendered another one)
  const stored = store.raw('lang');
  if (stored && stored !== ui.lang && STRINGS[stored]) { ui.lang = stored; document.documentElement.lang = stored; }
  $('#langLabel').textContent = ui.lang === 'bn' ? 'English' : 'বাংলা';
  applyI18n();
  onLang(rerenderForLang);
  renderHeroTitle();
  renderStatic();
  renderBatchCount();
  bindEvents();
  startRotator();
  updatePlatformBadge();
  updateBadge();
  renderQueue();

  const bm = `javascript:(function(){window.open('${location.origin}/?url='+encodeURIComponent(location.href),'_blank');})();`;
  $('#bookmarklet').setAttribute('href', bm);
  $('#bookmarklet').addEventListener('click', (e) => e.preventDefault());

  api('/api/config').then((c) => { state.config = c; }).catch(() => {});
  refreshHealth();
  restoreJobs();
  checkClipboard();

  // share target / deep link: /?url=...  or  ?text=... (Android share sheet)
  const params = new URLSearchParams(location.search);
  if (params.get('open') === 'downloads') { params.delete('open'); history.replaceState({}, '', location.pathname); openDrawer('queue'); }
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (shared) {
    const url = extractUrl(shared);
    params.delete('url'); params.delete('text'); params.delete('title');
    history.replaceState({}, '', location.pathname + (params.toString() ? '?' + params : ''));
    if (url) fetchInfo(url);
  }
}

init();
