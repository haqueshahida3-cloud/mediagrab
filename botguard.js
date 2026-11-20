// Invisible bot protection (Cloudflare Turnstile or Google reCAPTCHA v3). Loaded on demand by core.js the first time
// the server answers 403 "bot_check_required". Runs the check without any visible step for real visitors, sends the
// token to /api/bot/verify (the server then sets a short-lived signed cookie) and lets the caller retry.
import { t } from './core.js';

let pending = null;
const scripts = new Map();

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); reject(new Error('script')); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

const fail = (key = 'e2.bot_failed') => Object.assign(new Error(t(key)), { code: 'bot_failed' });

async function turnstileToken(cfg) {
  await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  return new Promise((resolve, reject) => {
    // "interaction-only": the widget stays hidden unless Cloudflare needs the visitor to do something
    const box = document.createElement('div');
    box.setAttribute('aria-live', 'polite');
    box.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;';
    document.body.appendChild(box);
    let id;
    const done = (fn, v) => { try { window.turnstile.remove(id); } catch { /* ignore */ } box.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, fail()), 60000);
    id = window.turnstile.render(box, {
      sitekey: cfg.site_key, action: cfg.action, appearance: 'interaction-only', theme: 'auto',
      callback: (token) => { clearTimeout(timer); done(resolve, token); },
      'error-callback': () => { clearTimeout(timer); done(reject, fail()); },
      'timeout-callback': () => { clearTimeout(timer); done(reject, fail()); },
    });
  });
}

async function recaptchaToken(cfg) {
  await loadScript(`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(cfg.site_key)}`);
  await new Promise((r) => window.grecaptcha.ready(r));
  const style = document.getElementById('mg-recaptcha-badge') || Object.assign(document.createElement('style'), { id: 'mg-recaptcha-badge' });
  style.textContent = '.grecaptcha-badge{visibility:hidden!important}';  // the required notice is shown in the footer
  document.head.appendChild(style);
  return window.grecaptcha.execute(cfg.site_key, { action: cfg.action });
}

/** Resolves when the visitor holds a valid human pass; concurrent callers share one check. */
export function ensureHuman() {
  if (pending) return pending;
  pending = (async () => {
    let cfg;
    try { cfg = await (await fetch('/api/bot/config', { cache: 'no-store' })).json(); } catch { throw fail(); }
    if (!cfg.enabled) return true;
    let token;
    try { token = await (cfg.provider === 'turnstile' ? turnstileToken(cfg) : recaptchaToken(cfg)); } catch (e) { throw e.code ? e : fail(); }
    let res;
    try {
      res = await fetch('/api/bot/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    } catch { throw fail(); }
    if (!res.ok) throw fail();
    return true;
  })().finally(() => { pending = null; });
  return pending;
}
