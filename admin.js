// Admin dashboard (owner only). English UI. Session = HttpOnly cookie set by /api/admin/login.
import { $, $$, esc, api, toast, icon, initChrome, fmtBytes, fmtSpeed, fmtDur, timeAgo, hydrateIcons } from './core.js';

const H = { 'X-Requested-With': 'MediaGrab' };
let timer = null, auto = true;

const pill = (ok, yes = 'OK', no = 'Missing', warn = false) => `<span class="pill ${ok ? 'ok' : warn ? 'warn' : 'bad'}">${esc(ok ? yes : no)}</span>`;
const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);
const meter = (p) => `<div class="meter ${p > 90 ? 'bad' : p > 75 ? 'warn' : ''}"><div style="width:${Math.min(100, p)}%"></div></div>`;
const rate = (v) => (v == null ? '—' : `${v}%`);
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

function renderLogin(msg = '') {
  clearInterval(timer);
  $('#adminApp').innerHTML = `
    <form class="card admin-login" id="loginForm">
      <h2 style="margin:0 0 6px;display:flex;gap:10px;align-items:center">${icon('lock')}Admin dashboard</h2>
      <p class="muted" style="margin:0 0 16px">Enter the <code>ADMIN_TOKEN</code> configured on the server.</p>
      <label class="field">Admin token<input class="input" type="password" id="tok" autocomplete="current-password" required minlength="12"></label>
      ${msg ? `<div class="notice" style="margin-top:12px">${icon('alert')}<div>${esc(msg)}</div></div>` : ''}
      <button class="btn btn-primary" style="margin-top:14px;width:100%">${icon('arrow-right')}<span>Sign in</span></button>
    </form>`;
  $('#tok').focus();
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/login', { method: 'POST', body: { token: $('#tok').value } });
      load();
    } catch (err) { renderLogin(err.message); }
  });
}

function render(d) {
  const s = d.system, mem = s.memory || {}, disk = s.disk || {};
  const active = d.jobs.list.filter((j) => ['queued', 'preparing', 'downloading', 'processing', 'paused'].includes(j.status));
  const counts = d.jobs.counts;
  const plats = Object.entries(d.platforms).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0));
  const notices = Object.entries(d.notices || {});
  $('#adminApp').innerHTML = `
    <div class="admin-head">
      <div><h1 style="margin:0;font-size:1.5rem;display:flex;gap:10px;align-items:center">${icon('activity')}System monitor</h1>
        <span class="muted" style="font-size:.84rem">${esc(d.app.name)} v${esc(d.app.version)} · updated ${new Date().toLocaleTimeString()}</span></div>
      <div class="row">
        <label class="switch" style="font-size:.86rem"><input type="checkbox" id="autoRef" ${auto ? 'checked' : ''}><span class="track"></span>Auto-refresh</label>
        <button class="chip-btn" id="refBtn">${icon('refresh')}Refresh</button>
        <button class="chip-btn" id="clrErr">${icon('trash')}Clear errors</button>
        <button class="chip-btn" id="clrCache">${icon('layers')}Clear caches</button>
        <button class="chip-btn danger" id="logout">${icon('logout')}Sign out</button>
      </div>
    </div>
    ${notices.map(([k, n]) => `<div class="notice" style="margin-bottom:10px">${icon('alert')}<div><b>${esc(k)}</b> — ${esc(n.message)} <span class="muted">(${esc(timeAgo(n.time * 1000))})</span></div></div>`).join('')}
    <div class="admin-grid">
      <div class="stat-card"><small>Backend</small><b>${pill(true, 'Healthy')}</b><div class="sub">uptime ${esc(dur(s.uptime))} · pid ${esc(s.pid)}</div></div>
      <div class="stat-card"><small>Jobs</small><b>${esc(active.length)} active</b><div class="sub">${esc(counts.queued || 0)} queued · ${esc(d.jobs.workers)} workers · ${esc(d.jobs.stats.completed)} done · ${esc(d.jobs.stats.failed)} failed</div></div>
      <div class="stat-card"><small>Success rate</small><b>${esc(rate(d.success.download))}</b><div class="sub">info ${esc(rate(d.success.info))} · photos ${esc(rate(d.success.gallery))} · tools ${esc(rate(d.success.convert))}</div></div>
      <div class="stat-card"><small>CPU</small><b>${s.cpu_percent != null ? esc(s.cpu_percent) + '%' : '—'}</b><div class="sub">limit ${esc(s.cpu_limit)} CPU · load ${esc((s.load || []).join(' / '))}</div>${meter(s.cpu_percent || 0)}</div>
      <div class="stat-card"><small>Memory (${esc(mem.scope || '')})</small><b>${esc(fmtBytes(mem.used))}</b><div class="sub">of ${esc(fmtBytes(mem.total))} · app ${esc(fmtBytes(s.process_rss))}</div>${meter(pct(mem.used, mem.total))}</div>
      <div class="stat-card"><small>Disk (DATA_DIR)</small><b>${esc(fmtBytes(disk.free))} free</b><div class="sub">${esc(fmtBytes(disk.used))} of ${esc(fmtBytes(disk.total))}</div>${meter(pct(disk.used, disk.total))}</div>
      <div class="stat-card"><small>Data served</small><b>${esc(fmtBytes(d.jobs.stats.bytes))}</b><div class="sub">cache: ${esc(d.cache.info)} info · ${esc(d.cache.gallery)} galleries</div></div>
      <div class="stat-card"><small>FFmpeg</small><b>${pill(d.ffmpeg.ok, 'Ready', 'Missing')}</b><div class="sub" title="${esc(d.ffmpeg.version || '')}">${esc((d.ffmpeg.version || 'not found').slice(0, 42))}</div></div>
    </div>
    <div class="admin-cols">
      <div>
        <div class="panel"><h3>${icon('download')}Queue & recent jobs <span class="muted" style="font-weight:500;font-size:.8rem">(${esc(d.jobs.list.length)})</span></h3>
          ${d.jobs.list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Status</th><th>Platform</th><th>Kind</th><th>Title</th><th>Progress</th><th>Size</th><th>Age</th><th></th></tr></thead><tbody>
          ${d.jobs.list.map((j) => `<tr><td>${pill(j.status === 'finished', j.status, j.status, !['error', 'cancelled'].includes(j.status))}${j.error_code ? ` <span class="muted">${esc(j.error_code)}</span>` : ''}</td>
            <td>${esc(j.platform)}</td><td>${esc(j.kind)} ${esc(j.label || '')}</td><td title="${esc(j.title)}">${esc((j.title || '').slice(0, 38))}</td>
            <td>${esc(j.progress)}%${j.speed ? ' · ' + esc(fmtSpeed(j.speed)) : ''}</td><td>${esc(fmtBytes(j.filesize))}</td><td>${esc(timeAgo(j.created * 1000))}</td>
            <td>${['queued', 'preparing', 'downloading', 'processing', 'paused'].includes(j.status) ? `<button class="chip-btn danger btn-xs" data-cancel="${esc(j.id)}">Cancel</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No jobs yet.</p>'}</div>
        <div class="panel"><h3>${icon('alert')}Error log <span class="muted" style="font-weight:500;font-size:.8rem">(${esc(d.errors.length)} recent, in memory only)</span></h3>
          ${d.errors.length ? d.errors.map((e) => `<div class="log-item"><div class="lh"><span class="code">${esc(e.code)}</span><span>${esc(e.area)}</span><span>${esc(e.platform)}</span><span>${esc(timeAgo(e.time * 1000))}</span></div>
            <div style="margin-top:4px">${esc(e.message)}</div>${e.url ? `<div class="muted" style="font-size:.76rem;word-break:break-all">${esc(e.url)}</div>` : ''}
            ${e.details && e.details.length ? `<details><summary class="muted" style="cursor:pointer;font-size:.78rem">yt-dlp diagnostics (${esc(e.details.length)})</summary><pre>${esc(e.details.join('\n'))}</pre></details>` : ''}</div>`).join('') : '<p class="muted">No errors recorded.</p>'}</div>
      </div>
      <div>
        <div class="panel"><h3>${icon('server')}Versions</h3><dl class="kv">
          <dt>yt-dlp</dt><dd>${esc(d.versions.yt_dlp)}</dd><dt>gallery-dl</dt><dd>${esc(d.versions.gallery_dl || '—')}</dd>
          <dt>FFmpeg</dt><dd>${esc(d.versions.ffmpeg || '—')}</dd><dt>Deno</dt><dd>${esc(d.versions.deno || '—')}</dd></dl></div>
        <div class="panel"><h3>${icon('grid')}Platforms</h3>${plats.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Platform</th><th>Info ✓/✕</th><th>Video ✓/✕</th><th>Photos ✓/✕</th></tr></thead><tbody>
          ${plats.map(([p, c]) => `<tr><td>${esc(p)}</td><td>${esc(c['info.ok'] || 0)} / ${esc(c['info.fail'] || 0)}</td><td>${esc(c['download.ok'] || 0)} / ${esc(c['download.fail'] || 0)}</td><td>${esc(c['gallery.ok'] || 0)} / ${esc(c['gallery.fail'] || 0)}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="muted">No requests yet.</p>'}</div>
        <div class="panel"><h3>${icon('shield')}Rate limiting</h3><dl class="kv">
          <dt>Limits / min / IP</dt><dd>info ${esc(d.rate_limit.limits.info)} · download ${esc(d.rate_limit.limits.download)} · tools ${esc(d.rate_limit.limits.tools)}</dd>
          <dt>Tracked clients</dt><dd>${esc(d.rate_limit.tracked_clients)}</dd>
          <dt>Blocked requests</dt><dd>${Object.keys(d.rate_limit.blocked).length ? Object.entries(d.rate_limit.blocked).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : 'none'}</dd></dl></div>
        <div class="panel"><h3>${icon('lock')}Cookies</h3><div class="row">${Object.entries(d.cookies).map(([p, ok]) => `<span>${esc(p)} ${pill(ok, 'loaded', 'none', true)}</span>`).join('')}</div>
          <p class="muted" style="font-size:.8rem;margin:10px 0 0">Add cookie files as Render “Secret Files” named <code>youtube.txt</code>, <code>facebook.txt</code>… — see cookies/README.md.</p></div>
        <div class="panel"><h3>${icon('sliders')}Limits</h3><dl class="kv">${Object.entries(d.limits).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
      </div>
    </div>`;
  hydrateIcons($('#adminApp'));
  $('#refBtn').onclick = load;
  $('#autoRef').onchange = (e) => { auto = e.target.checked; schedule(); };
  $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST', headers: H }).catch(() => {}); renderLogin(); };
  $('#clrErr').onclick = async () => { await api('/api/admin/errors/clear', { method: 'POST', headers: H }); toast('Error log cleared', 'ok'); load(); };
  $('#clrCache').onclick = async () => { await api('/api/admin/cache/clear', { method: 'POST', headers: H }); toast('Caches cleared', 'ok'); load(); };
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/jobs/${b.dataset.cancel}/cancel`, { method: 'POST', headers: H }).catch((e) => toast(e.message, 'err'));
    load();
  }));
}

function schedule() { clearInterval(timer); if (auto) timer = setInterval(() => { if (!document.hidden) load(true); }, 5000); }

async function load(quiet = false) {
  try {
    const d = await api('/api/admin/overview');
    render(d);
    schedule();
  } catch (e) {
    if (e.status === 401) renderLogin();
    else if (!quiet) $('#adminApp').innerHTML = `<div class="notice">${icon('alert')}<div>${esc(e.message)}</div></div>`;
  }
}

initChrome();
api('/api/admin/session').then((s) => (s.authenticated ? load() : renderLogin())).catch(() => renderLogin());
