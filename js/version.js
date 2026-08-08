/* Paragon Collectibles — build stamp
 *
 * ONE place to bump the version. Every page renders it into any element with
 * id="app-version", so a deploy you can't see is a deploy you can't trust —
 * if the header still shows the old number after a push, the browser is
 * serving cache or the push didn't land.
 */
(function () {
  'use strict';

  const APP_VERSION = '3.67.0';
  const BUILD_DATE  = '2026-08-04';

  function paint() {
    const bd = document.getElementById('build-date');
    if (bd) bd.textContent = 'Built ' + BUILD_DATE;
    document.querySelectorAll('#app-version, .app-version').forEach(el => {
      el.textContent = 'v' + APP_VERSION;
      el.title = 'Build ' + APP_VERSION + ' · ' + BUILD_DATE + ' — click to force-reload';
      if (!el.dataset.bound) {
        el.dataset.bound = '1';
        el.style.cursor = 'pointer';
        // Hard reload: the usual reason a version looks wrong is a cached page.
        el.addEventListener('click', () => location.reload(true));
      }
    });
  }

  window.APP_VERSION = APP_VERSION;
  window.BUILD_DATE = BUILD_DATE;
  window.paintVersion = paint;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint);
  } else {
    paint();
  }
})();
