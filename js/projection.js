/* Paragon Collectibles — position projections
 *
 * Position = inventory value + cash. Growth per show is measured on that,
 * because a show that converts inventory to cash at par hasn't grown anything
 * even though revenue looks good.
 *
 * Integer cents. No DOM, no app state.
 */
(function () {
  'use strict';

  const c = v => Math.round((Number(v) || 0) * 100);

  /** Position at the start and end of a closed show, and what it grew. */
  function showGrowth(ev) {
    if (!ev || !ev.startedAt || !ev.endedAt) return null;
    const open = c(ev.openInvValue) + c(ev.openCash);
    const close = c(ev.closeInvValue) + c(ev.closeCash);
    if (!open) return null;
    return {
      id: ev.id,
      name: ev.name,
      date: ev.date,
      openCents: open,
      closeCents: close,
      deltaCents: close - open,
      pct: Math.round(((close - open) / open) * 1000) / 10
    };
  }

  /** Every closed show, oldest first, with a running position. */
  function history(events) {
    return (events || [])
      .map(showGrowth)
      .filter(Boolean)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  /**
   * Growth rate to project with. Uses the average of recent closed shows when
   * there are any — a measured rate beats a guessed one — and falls back to
   * the supplied default when there's no history yet.
   */
  function impliedRate(events, fallbackPct, sample) {
    const h = history(events);
    if (!h.length) return { pct: fallbackPct, basis: 'estimate', shows: 0 };
    const recent = h.slice(-(sample || 3));
    const avg = recent.reduce((s, x) => s + x.pct, 0) / recent.length;
    return {
      pct: Math.round(avg * 10) / 10,
      basis: 'last ' + recent.length + ' show' + (recent.length === 1 ? '' : 's'),
      shows: h.length
    };
  }

  /**
   * Compound a starting position across upcoming shows.
   * `shows` is a list of { id, name, date } in the order they'll happen.
   */
  function project(startCents, ratePct, shows) {
    const r = (Number(ratePct) || 0) / 100;
    let pos = startCents;
    return (shows || []).map(s => {
      const before = pos;
      pos = Math.round(pos * (1 + r));
      return {
        id: s.id, name: s.name, date: s.date,
        beforeCents: before,
        afterCents: pos,
        gainCents: pos - before
      };
    });
  }

  /** Shows still to come: scheduled, not yet closed, soonest first. */
  function upcoming(events, todayISO) {
    const today = todayISO || new Date().toISOString().slice(0, 10);
    return (events || [])
      .filter(e => !e.endedAt && (e.date || '') >= today)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  /**
   * How a closed show landed against what the rate predicted.
   * Positive means it beat the projection.
   */
  function variance(actualPct, projectedPct) {
    if (actualPct == null || projectedPct == null) return null;
    return Math.round((actualPct - projectedPct) * 10) / 10;
  }

  const API = { showGrowth, history, impliedRate, project, upcoming, variance };
  if (typeof window !== 'undefined') window.Projection = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
