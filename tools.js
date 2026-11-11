// Media Tools page: audio extractor, image converter, thumbnails & frames, image downloader, metadata viewer.
import {
  $, $$, esc, t, api, toast, uploadFile, runJob, saveUrl, saveBlob, fmtBytes, fmtDur, localDigits, icon, brandIcon,
  hydrateIcons, initChrome, extractUrl, detectPlatform, pname, truncate,
} from './core.js';
import { makeZip } from './zip.js';
import { readExif, describeExif } from './exif.js';

let config = null;
const maxMb = () => config?.max_upload_mb || 200;
const ttl = () => config?.file_ttl_minutes || 30;
const TOOLS = ['audio', 'image', 'frame', 'photos', 'meta'];
const inited = new Set();

/* ------------------------------------------------------------------ shared UI */
const seg = (id, opts, active) => `<div class="seg" role="tablist" data-seg="${id}">${opts.map(([v, label]) =>
  `<button type="button" role="tab" data-v="${v}" class="${v === active ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>`;
const urlRow = (id, ph) => `<form class="url-row" id="${id}Form" novalidate><input class="input" id="${id}Url" type="url" inputmode="url" placeholder="${esc(ph)}" aria-label="${esc(ph)}">
  <button class="btn btn-primary" type="submit">${icon('arrow-right')}<span>${esc(t('tl.go'))}</span></button></form>`;
const dropzone = (id, accept, multiple, text, small = '') => `<label class="dropzone" id="${id}Drop" tabindex="0">
  <input type="file" id="${id}File" accept="${accept}" ${multiple ? 'multiple' : ''} hidden>
  <div class="dz-ic">${icon('upload')}</div><b>${esc(text)}</b>${small ? `<small>${esc(small)}</small>` : ''}</label>`;
const loading = (msg = t('tl.processing')) => `<div class="sk-status" style="margin:14px 0"><span class="spinner"></span><span>${esc(msg)}</span></div>`;
const errorBox = (e) => `<div class="notice" style="margin-top:14px">${icon('alert')}<div>${esc(e.message || e)}</div></div>`;
const kv = (rows) => `<dl class="kv">${rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const ratio = (w, h) => { const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, h) || 1; return `${w / d}:${h / d}`; };

function bindSeg(id, onChange) {
  const el = $(`[data-seg="${id}"]`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('button', el).forEach((x) => x.classList.toggle('active', x === b));
    onChange(b.dataset.v);
  });
}
function bindDrop(id, onFiles) {
  const dz = $(`#${id}Drop`), inp = $(`#${id}File`);
  inp.addEventListener('change', () => { if (inp.files.length) onFiles([...inp.files]); inp.value = ''; });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
}
function bindUrl(id, onUrl) {
  $(`#${id}Form`).addEventListener('submit', (e) => {
    e.preventDefault();
    const url = extractUrl($(`#${id}Url`).value);
    if (!url) { toast(t('err.invalidUrl'), 'err'); $(`#${id}Url`).focus(); return; }
    $(`#${id}Url`).value = url;
    onUrl(url);
  });
}
function jobLabel(j) {
  if (j.status === 'downloading' && j.progress) return localDigits(`${Math.floor(j.progress)}%`);
  if (j.status === 'processing' && j.progress) return `${t('stage.converting')} ${localDigits(Math.floor(j.progress))}%`;
  return t('stage.short.' + j.status);
}
/** Run a server job from a button: shows progress on the button, saves the file at the end. */
async function jobButton(btn, body, endpoint) {
  if (btn.dataset.fileUrl) { saveUrl(btn.dataset.fileUrl, btn.dataset.fileName || ''); return null; }
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    const job = await runJob(body, {
      endpoint,
      onUpdate: (j) => {
        btn.style.setProperty('--p', `${j.progress || 0}%`);
        btn.classList.toggle('indeterminate', !j.progress);
        btn.innerHTML = `<span class="spinner"></span><span>${esc(jobLabel(j))}</span>`;
      },
    });
    btn.classList.remove('is-busy', 'indeterminate');
    btn.classList.add('is-done');
    btn.innerHTML = `${icon('save')}<span>${esc(t('btn.saveFile'))}</span>`;
    btn.dataset.fileUrl = job.file_url;
    btn.dataset.fileName = job.filename;
    saveUrl(job.file_url, job.filename);
    return job;
  } catch (e) {
    btn.classList.remove('is-busy', 'indeterminate');
    btn.innerHTML = original;
    toast(e.message, 'err', { timeout: 6500 });
    return null;
  } finally {
    btn.disabled = false;
  }
}
const mediaLine = (m) => [m.width ? `${m.width}×${m.height}` : '', m.vcodec, m.fps ? `${Math.round(m.fps)}fps` : '', m.acodec,
  m.audio_bitrate ? `${Math.round(m.audio_bitrate / 1000)} kbps` : '', m.sample_rate ? `${m.sample_rate / 1000} kHz` : '',
  m.duration ? fmtDur(m.duration) : ''].filter(Boolean).join(' · ');

/* ------------------------------------------------------------------ tabs */
function showTool(name) {
  if (!TOOLS.includes(name)) name = 'audio';
  $$('.tools-tabs [data-tool]').forEach((b) => { b.classList.toggle('active', b.dataset.tool === name); b.setAttribute('aria-selected', String(b.dataset.tool === name)); });
  $$('[data-panel-tool]').forEach((p) => p.classList.toggle('hidden', p.dataset.panelTool !== name));
  if (!inited.has(name)) { inited.add(name); ({ audio: initAudio, image: initImage, frame: initFrame, photos: initPhotos, meta: initMeta })[name](); }
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

/* ------------------------------------------------------------------ 1. audio extractor */
function initAudio() {
  const root = $('#audioUi');
  root.innerHTML = `${seg('audioMode', [['link', t('tl.fromLink')], ['file', t('tl.fromFile')]], 'link')}
    <div id="audioLinkPane">${urlRow('audio', t('tl.linkPh'))}<div class="tool-result" id="audioLinkRes"></div></div>
    <div id="audioFilePane" class="hidden">${dropzone('audio', 'audio/*,video/*,.mkv,.mov,.m4a,.flac,.opus,.webm', false, t('tl.drop'), t('tl.uploadNote', { m: localDigits(ttl()), n: localDigits(maxMb()) }))}
      <div class="tool-result" id="audioFileRes"></div></div>`;
  bindSeg('audioMode', (v) => { $('#audioLinkPane').classList.toggle('hidden', v !== 'link'); $('#audioFilePane').classList.toggle('hidden', v !== 'file'); });
  bindUrl('audio', async (url) => {
    const res = $('#audioLinkRes');
    res.innerHTML = loading();
    try {
      const d = await api('/api/info', { method: 'POST', body: { url } });
      if (d.type !== 'video' || !d.audio?.length) {
        res.innerHTML = `<div class="notice info" style="margin-top:14px">${icon('info')}<div>${esc(d.type === 'gallery' ? t('tl.photosD') : t('rc.noAudio'))}
          <div style="margin-top:8px"><a class="chip-btn" href="/?url=${encodeURIComponent(url)}">${icon('external')}${esc(t('tl.openDownloader'))}</a></div></div></div>`;
        return;
      }
      res.innerHTML = `<div class="file-row" style="margin:14px 0 10px"><div class="fr-thumb">${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" data-fallback>` : icon('film')}</div>
          <div style="min-width:0"><b>${esc(d.title)}</b><small>${esc(pname(d.platform))}${d.duration ? ' · ' + fmtDur(d.duration) : ''}</small></div>
          <a class="chip-btn" href="/?url=${encodeURIComponent(url)}">${icon('external')}</a></div>
        <div class="fmt-list">${d.audio.map((a) => `<div class="fmt-row"><span class="q-badge ${a.label === 'MP3' ? 'q-AUD' : 'q-AUD2'}">${esc(a.label)}</span>
          <div class="fmt-main"><b>${esc(a.tier === 'kbps' ? `${localDigits(a.kbps)} kbps` : t('aq.' + a.tier))}</b><small>${esc(a.quality)}</small></div>
          <span class="fmt-size">${a.size ? '~' + fmtBytes(a.size) : '—'}</span>
          <button class="btn-dl" type="button" data-aq="${esc(a.id)}">${icon('download')}<span>${esc(t('btn.download'))}</span></button></div>`).join('')}</div>`;
      $$('[data-aq]', res).forEach((b) => b.addEventListener('click', () => jobButton(b, { url, kind: 'audio', quality: b.dataset.aq, title: d.title, thumbnail: d.thumbnail })));
    } catch (e) { res.innerHTML = errorBox(e); }
  });

  let upload = null, file = null;
  bindDrop('audio', async ([f]) => {
    if (f.size > maxMb() * 1024 * 1024) { toast(t('tip.too_large'), 'err'); return; }
    file = f; upload = null;
    const res = $('#audioFileRes');
    const targets = config?.convert_targets || [{ id: 'mp3-320', label: 'MP3 320 kbps' }];
    res.innerHTML = `<div class="file-row" style="margin-top:14px"><div class="fr-thumb">${icon(f.type.startsWith('audio') ? 'music' : 'film')}</div>
        <div style="min-width:0"><b>${esc(f.name)}</b><small>${esc(fmtBytes(f.size))} · ${esc(f.type || '—')}</small></div><span></span></div>
      <div class="opt-grid"><label class="field">${esc(t('tl.format'))}<select class="select" id="convTarget">${targets.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('')}</select></label></div>
      <div class="row"><button class="btn btn-primary" type="button" id="convGo">${icon('convert')}<span>${esc(t('tl.convert'))}</span></button>
        <span class="muted" id="convStatus" aria-live="polite"></span></div>
      <div class="progress-inline" style="margin-top:10px"><div id="convBar"></div></div>
      <div id="convOut" class="file-list"></div>`;
    $('#convGo').addEventListener('click', async () => {
      const go = $('#convGo'), status = $('#convStatus'), bar = $('#convBar');
      go.disabled = true;
      try {
        if (!upload) {
          upload = await uploadFile(file, (p) => { status.textContent = t('tl.uploading', { p: localDigits(Math.round(p * 100)) }); bar.style.width = `${Math.round(p * 50)}%`; });
        }
        const target = $('#convTarget').value;
        const job = await runJob({ upload_id: upload.upload_id, target }, {
          endpoint: '/api/tools/convert',
          onUpdate: (j) => { status.textContent = j.status === 'queued' ? t('stage.queued') : `${t('stage.converting')} ${localDigits(Math.floor(j.progress || 0))}%`; bar.style.width = `${50 + (j.progress || 0) / 2}%`; },
        });
        bar.style.width = '100%';
        status.textContent = t('tl.done');
        const row = document.createElement('div');
        row.className = 'file-row';
        row.innerHTML = `<div class="fr-thumb">${icon('music')}</div><div style="min-width:0"><b>${esc(job.filename)}</b><small>${esc(fmtBytes(job.filesize))} · ${esc(mediaLine(job.media || {}))}</small></div>
          <button class="chip-btn primary" type="button">${icon('save')}${esc(t('btn.saveFile'))}</button>`;
        row.querySelector('button').addEventListener('click', () => saveUrl(job.file_url, job.filename));
        $('#convOut').prepend(row);
        saveUrl(job.file_url, job.filename);
      } catch (e) {
        status.textContent = '';
        bar.style.width = '0';
        toast(e.message, 'err', { timeout: 6500 });
        if (e.code === 'upload_expired') upload = null;
      } finally { go.disabled = false; }
    });
  });
}

/* ------------------------------------------------------------------ 2. image converter (in the browser) */
const canWebp = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL('image/webp').startsWith('data:image/webp'); } catch { return false; } })();
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function initImage() {
  const root = $('#imageUi');
  const files = [];
  root.innerHTML = `${dropzone('image', 'image/*', true, t('tl.dropImages'), t('tl.localOnly'))}
    <div class="opt-grid">
      <label class="field">${esc(t('tl.format'))}<select class="select" id="imgFmt">
        <option value="image/jpeg">JPG</option><option value="image/png">PNG</option><option value="image/webp" ${canWebp ? '' : 'disabled'}>WebP${canWebp ? '' : ' ✕'}</option></select></label>
      <label class="field" id="imgQWrap"><span>${esc(t('tl.quality'))} · <b id="imgQVal">85</b>%</span><div class="range-row"><input type="range" id="imgQ" min="10" max="100" value="85" aria-label="${esc(t('tl.quality'))}"></div></label>
      <label class="field">${esc(t('tl.resize'))}<input class="input" id="imgW" type="number" min="16" max="16000" placeholder="${esc(t('tl.keepSize'))}"></label>
    </div>
    <div class="row"><button class="btn btn-primary" type="button" id="imgGo" disabled>${icon('convert')}<span>${esc(t('tl.convertAll'))}</span></button>
      <button class="btn btn-ghost" type="button" id="imgZip" disabled>${icon('archive')}<span>${esc(t('tl.zipAll'))}</span></button>
      <button class="chip-btn" type="button" id="imgClear">${icon('trash')}${esc(t('tl.clear'))}</button></div>
    <div class="file-list" id="imgList"></div>`;
  const fmtSel = $('#imgFmt');
  const syncQ = () => { $('#imgQWrap').classList.toggle('hidden', fmtSel.value === 'image/png'); $('#imgQVal').textContent = localDigits($('#imgQ').value); };
  fmtSel.addEventListener('change', syncQ);
  $('#imgQ').addEventListener('input', syncQ);

  const render = () => {
    $('#imgList').innerHTML = files.map((f, i) => {
      const o = f.out;
      const diff = o ? Math.round((1 - o.blob.size / f.file.size) * 100) : 0;
      return `<div class="file-row"><div class="fr-thumb"><img src="${esc(f.url)}" alt=""></div>
        <div style="min-width:0"><b>${esc(f.file.name)}</b>
          <small>${esc(fmtBytes(f.file.size))}${f.w ? ` · ${localDigits(`${f.w}×${f.h}`)}` : ''}${o ? ` → <b>${esc(o.name)}</b> · ${esc(fmtBytes(o.blob.size))} · ${localDigits(`${o.w}×${o.h}`)} · ${esc(diff >= 0 ? t('tl.smaller', { p: localDigits(diff) }) : t('tl.larger', { p: localDigits(-diff) }))}` : ''}</small></div>
        ${o ? `<button class="chip-btn primary" type="button" data-imgsave="${i}">${icon('save')}${esc(t('tl.download'))}</button>` : `<span class="muted" style="font-size:.78rem">${esc(f.state || '')}</span>`}</div>`;
    }).join('');
    $('#imgGo').disabled = !files.length;
    $('#imgZip').disabled = !files.some((f) => f.out);
  };
  bindDrop('image', async (list) => {
    for (const file of list) {
      if (!file.type.startsWith('image/')) { toast(`${file.name}: ${t('tl.unsupported')}`, 'err'); continue; }
      const entry = { file, url: URL.createObjectURL(file), out: null };
      files.push(entry);
      createImageBitmap(file).then((b) => { entry.w = b.width; entry.h = b.height; b.close(); render(); }).catch(() => { entry.state = t('tl.unsupported'); render(); });
    }
    render();
  });
  $('#imgList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-imgsave]');
    if (b) { const f = files[+b.dataset.imgsave]; saveBlob(f.out.blob, f.out.name); }
  });
  $('#imgGo').addEventListener('click', async () => {
    const type = fmtSel.value;
    if (type === 'image/webp' && !canWebp) { toast(t('tl.webpNo'), 'err'); return; }
    const q = +$('#imgQ').value / 100, maxW = +$('#imgW').value || 0;
    $('#imgGo').disabled = true;
    for (const f of files) {
      try {
        f.state = t('tl.processing'); render();
        const bmp = await createImageBitmap(f.file);
        const scale = maxW && bmp.width > maxW ? maxW / bmp.width : 1;
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const blob = await new Promise((r) => c.toBlob(r, type, type === 'image/png' ? undefined : q));
        if (!blob) throw new Error(t('tl.unsupported'));
        if (f.out?.url) URL.revokeObjectURL(f.out.url);
        f.out = { blob, w, h, name: `${f.file.name.replace(/\.[^.]+$/, '') || 'image'}.${EXT[type]}` };
        f.state = '';
      } catch (e) { f.state = e.message || t('tl.unsupported'); }
      render();
      await new Promise((r) => setTimeout(r, 0));  // keep the UI responsive on phones
    }
    $('#imgGo').disabled = false;
    toast(t('tl.done'), 'ok');
  });
  $('#imgZip').addEventListener('click', async () => {
    const done = files.filter((f) => f.out);
    if (!done.length) return;
    const zip = await makeZip(done.map((f) => ({ name: f.out.name, blob: f.out.blob })));
    saveBlob(zip, `MediaGrab images (${done.length}).zip`);
  });
  $('#imgClear').addEventListener('click', () => { files.forEach((f) => URL.revokeObjectURL(f.url)); files.length = 0; render(); });
  syncQ();
}

/* ------------------------------------------------------------------ 3. thumbnails & frames */
function initFrame() {
  const root = $('#frameUi');
  root.innerHTML = `${seg('frameMode', [['link', t('tl.fromLink')], ['file', t('tl.fromFile')]], 'link')}
    <div id="frameLinkPane">${urlRow('frame', t('tl.linkPh'))}<div class="tool-result" id="frameLinkRes"></div></div>
    <div id="frameFilePane" class="hidden">${dropzone('frame', 'video/*', false, t('tl.drop'), t('tl.localOnly'))}<div class="tool-result" id="frameFileRes"></div></div>`;
  bindSeg('frameMode', (v) => { $('#frameLinkPane').classList.toggle('hidden', v !== 'link'); $('#frameFilePane').classList.toggle('hidden', v !== 'file'); });
  bindUrl('frame', async (url) => {
    const res = $('#frameLinkRes');
    res.innerHTML = loading();
    try {
      const d = await api('/api/info', { method: 'POST', body: { url } });
      const thumbs = d.type === 'video' ? d.thumbnails : (d.items || []).filter((i) => i.preview).map((i) => ({ url: i.preview, download: null, label: i.label || '' }));
      if (!thumbs?.length) { res.innerHTML = errorBox(t('tl.noThumbs')); return; }
      res.innerHTML = `<div class="thumb-grid" style="margin-top:14px">${thumbs.map((th) => `<div class="thumb-card"><div class="ti"><img loading="lazy" src="${esc(th.url)}" alt="" data-fallback></div>
        <div class="tf"><span>${esc(localDigits(th.label === 'Original' ? t('rc.original') : th.label))}</span>${th.download ? `<a class="chip-btn" href="${esc(th.download)}" download>${icon('download')}${esc(t('btn.save'))}</a>` : `<a class="chip-btn" href="/?url=${encodeURIComponent(url)}">${icon('external')}</a>`}</div></div>`).join('')}</div>`;
    } catch (e) { res.innerHTML = errorBox(e); }
  });
  let videoUrl = null;
  bindDrop('frame', ([f]) => {
    if (!f.type.startsWith('video/')) { toast(t('tl.unsupported'), 'err'); return; }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(f);
    const res = $('#frameFileRes');
    res.innerHTML = `<div class="frame-stage" style="margin-top:14px"><video id="frameVideo" src="${videoUrl}" controls playsinline preload="metadata"></video></div>
      <p class="muted" style="font-size:.84rem" id="frameInfo">${esc(t('tl.frameHint'))}</p>
      <div class="row"><select class="select" id="frameFmt" style="width:auto" aria-label="${esc(t('tl.captureAs'))}"><option value="image/png">PNG</option><option value="image/jpeg">JPG</option>${canWebp ? '<option value="image/webp">WebP</option>' : ''}</select>
        <button class="btn btn-primary" type="button" id="frameCap">${icon('camera')}<span>${esc(t('tl.capture'))}</span></button></div>
      <div class="thumb-grid" id="frameShots" style="margin-top:14px"></div>`;
    const v = $('#frameVideo');
    v.addEventListener('loadedmetadata', () => { $('#frameInfo').textContent = `${v.videoWidth}×${v.videoHeight} · ${fmtDur(v.duration)} · ${t('tl.frameHint')}`; });
    $('#frameCap').addEventListener('click', async () => {
      if (!v.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const type = $('#frameFmt').value;
      const blob = await new Promise((r) => c.toBlob(r, type, 0.92));
      if (!blob) return;
      const name = `${f.name.replace(/\.[^.]+$/, '')} @ ${fmtDur(v.currentTime).replace(/:/g, '-')}.${EXT[type]}`;
      const url = URL.createObjectURL(blob);
      const card = document.createElement('div');
      card.className = 'thumb-card';
      card.innerHTML = `<div class="ti"><img src="${url}" alt=""></div><div class="tf"><span>${esc(fmtDur(v.currentTime))} · ${v.videoWidth}×${v.videoHeight}</span><button class="chip-btn" type="button">${icon('download')}${esc(t('btn.save'))}</button></div>`;
      card.querySelector('button').addEventListener('click', () => saveBlob(blob, name));
      $('#frameShots').prepend(card);
      saveBlob(blob, name);
    });
  });
}

/* ------------------------------------------------------------------ 4. image downloader */
function initPhotos() {
  const root = $('#photosUi');
  root.innerHTML = `${urlRow('photos', t('tl.photoPh'))}<div class="tool-result" id="photosRes"></div>`;
  bindUrl('photos', async (url) => {
    const res = $('#photosRes');
    res.innerHTML = loading();
    try {
      const d = await api('/api/info', { method: 'POST', body: { url } });
      if (d.type !== 'gallery') {
        res.innerHTML = `<div class="notice info" style="margin-top:14px">${icon('info')}<div>${esc(t('mt.' + (d.media_type || 'video')))} — ${esc(truncate(d.title, 80))}
          <div style="margin-top:8px"><a class="chip-btn" href="/?url=${encodeURIComponent(url)}">${icon('external')}${esc(t('tl.openDownloader'))}</a></div></div></div>`;
        return;
      }
      const visual = d.items.filter((i) => i.type !== 'audio');
      res.innerHTML = `<div class="row" style="margin:14px 0"><span class="mt-badge">${icon('images')}${esc(t('mt.' + d.media_type))}</span>
          <span class="pl-kicker pf-${esc(d.platform)}">${brandIcon(d.platform)}${esc(pname(d.platform))}</span><b style="min-width:0">${esc(truncate(d.title, 90))}</b><span class="grow"></span>
          ${visual.length > 1 ? `<button class="btn btn-primary btn-sm" type="button" id="photosZip">${icon('archive')}<span>${esc(t('g.dlAll'))}</span></button>` : ''}</div>
        ${d.note === 'partial' ? `<div class="max-note warn">${icon('info')}<div>${esc(t('g.partial', { n: localDigits(d.counts.image), t: localDigits(d.total || '?') }))}</div></div>` : ''}
        <div class="g-grid">${d.items.map((it) => `<div class="g-item"><div class="g-media">${it.preview ? `<img loading="lazy" src="${esc(it.preview)}" alt="" data-fallback>` : icon(it.type === 'audio' ? 'music' : 'film')}
            ${it.type !== 'image' ? `<span class="g-type">${icon(it.type === 'audio' ? 'music' : 'play')}${esc(it.type === 'audio' ? t('g.sound') : t('mt.video'))}</span>` : ''}</div>
          <div class="g-foot"><span>${esc(it.label ? localDigits(it.label) : '')} ${esc((it.ext || '').toUpperCase())}</span>
          <button class="btn-dl" type="button" data-pi="${it.index}">${icon('download')}<span>${esc(t('btn.download'))}</span></button></div></div>`).join('')}</div>`;
      $$('[data-pi]', res).forEach((b) => b.addEventListener('click', () => jobButton(b, { url, kind: 'gallery', items: [+b.dataset.pi], title: d.title })));
      $('#photosZip')?.addEventListener('click', (e) => jobButton(e.currentTarget, { url, kind: 'gallery', items: [], title: d.title }));
    } catch (e) { res.innerHTML = errorBox(e); }
  });
}

/* ------------------------------------------------------------------ 5. metadata viewer */
function initMeta() {
  const root = $('#metaUi');
  root.innerHTML = `${seg('metaMode', [['link', t('tl.metaLink')], ['file', t('tl.metaFile')]], 'link')}
    <div id="metaLinkPane">${urlRow('meta', t('tl.linkPh'))}<div class="tool-result" id="metaLinkRes"></div></div>
    <div id="metaFilePane" class="hidden">${dropzone('meta', 'image/*,video/*,audio/*', false, t('tl.drop'))}<div class="tool-result" id="metaFileRes"></div></div>`;
  bindSeg('metaMode', (v) => { $('#metaLinkPane').classList.toggle('hidden', v !== 'link'); $('#metaFilePane').classList.toggle('hidden', v !== 'file'); });

  bindUrl('meta', async (url) => {
    const res = $('#metaLinkRes');
    res.innerHTML = loading();
    try {
      const d = await api('/api/formats', { method: 'POST', body: { url } });
      if (d.gallery || !d.formats.length) {
        res.innerHTML = `<div class="notice info" style="margin-top:14px">${icon('info')}<div>${esc(t('tl.photosD'))}<div style="margin-top:8px"><a class="chip-btn" href="/?url=${encodeURIComponent(url)}">${icon('external')}${esc(t('tl.openDownloader'))}</a></div></div></div>`;
        return;
      }
      const fm = [...d.formats].sort((a, b) => ((b.height ? Math.min(b.width || b.height, b.height) : 0) - (a.height ? Math.min(a.width || a.height, a.height) : 0)) || ((b.tbr || b.abr || 0) - (a.tbr || a.abr || 0)));
      const maxH = Math.max(0, ...fm.filter((f) => f.vcodec).map((f) => Math.min(f.width || f.height || 0, f.height || 0)));
      res.innerHTML = `<div class="meta-cards"><div class="meta-card"><h4>${icon('info')}${esc(d.title || '')}</h4>${kv([
          [t('tl.type'), pname(d.platform)], ['Extractor', d.extractor], [t('tl.duration'), d.duration ? fmtDur(d.duration) : null],
          [t('tl.formats', { n: localDigits(fm.length) }), `${t('tl.resolution')}: ${maxH ? localDigits(maxH) + 'p ' + t('tl.best') : '—'}`]])}</div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>${esc(t('tl.type'))}</th><th>${esc(t('tl.resolution'))}</th><th>${esc(t('tl.fps'))}</th>
          <th>${esc(t('tl.codec'))}</th><th>${esc(t('tl.bitrate'))}</th><th>${esc(t('tl.size'))}</th><th>Ext</th><th>Protocol</th></tr></thead><tbody>
          ${fm.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.vcodec && f.acodec ? t('tl.withAudio') : f.vcodec ? t('tl.videoOnly') : t('tl.audioOnly'))}</td>
            <td>${esc(f.resolution || '—')}${f.dynamic_range && f.dynamic_range !== 'SDR' ? ' <b>HDR</b>' : ''}</td><td>${esc(f.fps || '')}</td>
            <td>${esc([f.vcodec, f.acodec].filter(Boolean).join(' + '))}</td><td>${esc(f.tbr ? Math.round(f.tbr) + ' kbps' : f.abr ? Math.round(f.abr) + ' kbps' : '')}</td>
            <td>${esc(f.size ? (f.approx ? '~' : '') + fmtBytes(f.size) : '')}</td><td>${esc(f.ext || '')}</td><td>${esc(f.protocol || '')}</td></tr>`).join('')}
          </tbody></table></div>`;
    } catch (e) { res.innerHTML = errorBox(e); }
  });

  bindDrop('meta', async ([f]) => {
    const res = $('#metaFileRes');
    const basic = [[t('tl.size'), fmtBytes(f.size)], [t('tl.mime'), f.type || '—'], [t('tl.modified'), new Date(f.lastModified).toLocaleString()]];
    res.innerHTML = loading();
    const cards = [];
    if (f.type.startsWith('image/')) {
      const bmp = await createImageBitmap(f).catch(() => null);
      if (bmp) { basic.push([t('tl.dimensions'), `${bmp.width} × ${bmp.height}`], [t('tl.megapixels'), (bmp.width * bmp.height / 1e6).toFixed(2) + ' MP'], [t('tl.aspect'), ratio(bmp.width, bmp.height)]); bmp.close(); }
      const ex = describeExif(await readExif(f));
      cards.push(`<div class="meta-card"><h4>${icon('camera')}${esc(t('tl.exif'))}</h4>${ex.length ? kv(ex.map(([k, v]) => [k, v])) : `<p class="muted" style="margin:0">${esc(t('tl.noExif'))}</p>`}
        ${ex.some((r) => r[2] === 'gps') ? `<div class="max-note warn" style="margin:10px 0 0">${icon('alert')}<div>${esc(t('tl.gpsWarn'))}</div></div>` : ''}</div>`);
    } else if (f.type.startsWith('video/') || f.type.startsWith('audio/')) {
      const el = document.createElement(f.type.startsWith('video/') ? 'video' : 'audio');
      el.preload = 'metadata';
      const u = URL.createObjectURL(f);
      el.src = u;
      await new Promise((r) => { el.onloadedmetadata = r; el.onerror = r; setTimeout(r, 8000); });
      if (el.duration && isFinite(el.duration)) basic.push([t('tl.duration'), fmtDur(el.duration)]);
      if (el.videoWidth) basic.push([t('tl.resolution'), `${el.videoWidth} × ${el.videoHeight}`], [t('tl.aspect'), ratio(el.videoWidth, el.videoHeight)]);
      if (el.duration && isFinite(el.duration)) basic.push([t('tl.bitrate'), `~${Math.round(f.size * 8 / el.duration / 1000)} kbps`]);
      URL.revokeObjectURL(u);
      cards.push(`<div class="meta-card"><h4>${icon('activity')}${esc(t('tl.analyze'))}</h4>
        <p class="muted" style="margin:0 0 10px;font-size:.84rem">${esc(t('tl.uploadNote', { m: localDigits(ttl()), n: localDigits(maxMb()) }))}</p>
        <button class="btn btn-ghost btn-sm" type="button" id="probeGo">${icon('upload')}<span>${esc(t('tl.analyze'))}</span></button><div id="probeOut"></div></div>`);
    } else {
      cards.push(`<div class="meta-card"><p class="muted" style="margin:0">${esc(t('tl.unsupported'))}</p></div>`);
    }
    res.innerHTML = `<div class="meta-cards"><div class="meta-card"><h4>${icon('file')}${esc(f.name)}</h4>${kv(basic)}</div>${cards.join('')}</div>`;
    $('#probeGo')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget, out = $('#probeOut');
      if (f.size > maxMb() * 1024 * 1024) { toast(t('tip.too_large'), 'err'); return; }
      btn.disabled = true;
      try {
        const up = await uploadFile(f, (p) => { btn.querySelector('span').textContent = t('tl.uploading', { p: localDigits(Math.round(p * 100)) }); });
        btn.querySelector('span').textContent = t('tl.processing');
        const p = await api('/api/tools/probe', { method: 'POST', body: { upload_id: up.upload_id } });
        api(`/api/tools/upload/${up.upload_id}`, { method: 'DELETE' }).catch(() => {});
        btn.remove();
        out.innerHTML = `${kv([[t('tl.container'), p.container], [t('tl.duration'), p.duration ? fmtDur(p.duration) : null], [t('tl.bitrate'), p.bitrate ? Math.round(p.bitrate / 1000) + ' kbps' : null], [t('tl.chapters'), p.chapters || null]])}
          ${p.streams.map((s) => `<div class="meta-card" style="margin-top:10px"><h4>${icon(s.type === 'audio' ? 'music' : s.type === 'cover' ? 'image' : 'film')}${esc(s.type === 'video' ? t('tl.video') : s.type === 'audio' ? t('tl.audioStream') : s.type === 'cover' ? t('tl.cover') : s.type)}</h4>${kv([
            [t('tl.codec'), [s.codec, s.profile].filter(Boolean).join(' · ')], [t('tl.resolution'), s.width ? `${s.width} × ${s.height}` : null], [t('tl.fps'), s.fps],
            ['Pixel format', s.pix_fmt], [t('tl.hdr'), ['smpte2084', 'arib-std-b67'].includes(s.color_transfer) ? 'Yes' : null],
            [t('tl.sampleRate'), s.sample_rate ? `${s.sample_rate} Hz` : null], [t('tl.channels'), s.channels ? `${s.channels}${s.channel_layout ? ' (' + s.channel_layout + ')' : ''}` : null],
            [t('tl.bitrate'), s.bitrate ? Math.round(s.bitrate / 1000) + ' kbps' : null], ['Language', s.language]])}</div>`).join('')}
          ${Object.keys(p.tags || {}).length ? `<div class="meta-card" style="margin-top:10px"><h4>${icon('type')}${esc(t('tl.tags'))}</h4>${kv(Object.entries(p.tags))}</div>` : ''}`;
      } catch (err) {
        btn.disabled = false;
        btn.querySelector('span').textContent = t('tl.analyze');
        toast(err.message, 'err');
      }
    });
  });
}

/* ------------------------------------------------------------------ init */
initChrome();
api('/api/config').then((c) => { config = c; }).catch(() => {}).finally(() => {
  $$('.tools-tabs [data-tool]').forEach((b) => b.addEventListener('click', () => showTool(b.dataset.tool)));
  showTool((location.hash || '#audio').slice(1));
  hydrateIcons();
});
window.addEventListener('hashchange', () => showTool(location.hash.slice(1)));
