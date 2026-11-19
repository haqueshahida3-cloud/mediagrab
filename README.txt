MediaGrab Dashboard Add-on (Patch ZIP)\n
This patch is designed for the uploaded mediagrab-v2-flat-upload project. It adds the requested dashboard UI without replacing downloader/backend functionality.


FEATURES:
- Active downloads, queue, completed and failed counters
- Download file count and estimated data total from existing browser history
- Download speed graph (polls existing /api/jobs endpoint)
- Recent activity panel
- Animated cards and platform color indicators
- Floating mini download panel
- Command palette (Ctrl/Cmd + K)
- Dashboard customization (hide/show cards, accent color, sound toggle)
- Mobile bottom navigation
- Drag/drop URL onto existing download input


QUICK INSTALL:
1. Extract this ZIP into your project's root, allowing files under patch/ to remain in patch/ for reference.
2. Copy patch/templates/base.html over your project's base.html.
3. Copy patch/templates/index.html over your project's index.html.
4. Copy patch/static/css/dashboard-addon.css into static/css/.
5. Copy patch/static/js/dashboard-addon.js into static/js/.
6. Commit/push to GitHub and redeploy Render.

The patch/base and patch/index files are already edited and include the stylesheet and JS references. The unpatched original files are not included, so make a backup of your originals before replacing them.


NOTES:
- Dashboard uses local browser records and existing /api/jobs endpoint. It does not add new backend routes.
- Completed/data totals are estimates based on recent records available in the browser; not a lifetime server-wide account statistic.
- Sound is optional and can be toggled off in Dashboard settings.
- Polling is every 2 seconds; edit setInterval(refresh, 2000) in dashboard-addon.js to change.
