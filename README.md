# MediaGrab UX Upgrade Add-on (Patch)

This is an **additive UI patch**. It does not change download APIs or backend code.

## Included
- Best-effort browser-visible download speed estimate (not true server transfer speed; existing download records may not expose byte/time data)
- Language/locale selector with a large selectable language label list (includes 210+ entries; it does not translate the whole app automatically)
- Font selector with 210 selectable font-family entries (font families may fall back if not installed/available; selector does not automatically load external font files)
- Skeleton loading demo button
- Micro-interaction card hover motion
- Page fade-in transition
- Scroll-triggered reveal animations using IntersectionObserver
- Empty-state message for empty lists
- High contrast toggle
- Font size control
- Drag/drop URL into URL input, when a matching input exists
- Reduced-motion accessibility support

## Install
1. Extract this ZIP.
2. Copy `static/css/mediagrab-ux-upgrade.css` to your project's `static/css/`.
3. Copy `static/js/mediagrab-ux-upgrade.js` to `static/js/`.
4. Copy the lines in `patch/integration-snippet.html` into `templates/base.html`: CSS in `<head>`, script just before `</body>`.
5. Commit and push to GitHub, then redeploy on Render.
6. Clear browser cache / hard refresh after deployment.


## Important
- Back up `base.html` before edits.
- The language picker is a selectable catalog, not complete localization. Real translations need locale files and app strings.
- Speed is an estimated indicator only; server download speed needs backend instrumentation/events for accurate real-time rate.
- Fonts are selectable by family name; many are device/browser fallback fonts. External font loading is intentionally not automatic.
