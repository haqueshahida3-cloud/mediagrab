// Content pages (About, FAQ, legal, API docs…): shared chrome + small enhancements.
import { initChrome, $$, icon, toast, t } from './core.js';

initChrome();

// copy buttons on code samples (API docs)
$$('.prose pre').forEach((pre) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip-btn btn-xs';
  btn.style.cssText = 'float:right;margin:-4px -6px 0 8px';
  btn.innerHTML = `${icon('copy')}Copy`;
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText); toast(t('toast.copied'), 'ok'); } catch { /* ignore */ }
  });
  pre.prepend(btn);
});
