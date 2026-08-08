/* Paragon Collectibles — show performance
 *
 * A show is a time window. Everything that happened between startedAt and
 * endedAt belongs to it, so nothing has to be tagged with an event id and the
 * report works retroactively on records that predate this feature.
 *
 * Integer cents throughout. No DOM, no app state.
 */
(function () {
  'use strict';

  const c = v => Math.round((Number(v) || 0) * 100);
  const inWindow = (t, from, to) => t != null && t >= from && (to == null || t <= to);

  const exitTime = card => card.exitAt || card.soldAt || 0;
  const exitVal  = card => card.exitValue != null ? card.exitValue : (card.soldPrice || 0);
  const exitKind = card => card.exitType || (card.soldPrice ? 'sale' : null);

  /** TCG value of everything still on hand. */
  function inventoryValueCents(cards) {
    return cards
      .filter(x => !x.soldPrice && !x.exitType && !x.archived)
      .reduce((s, x) => s + c(x.tcgPrice) * (parseInt(x.qty, 10) || 1), 0);
  }

  /**
   * @param show    { startedAt, endedAt, openInvValue, closeInvValue, fee }
   * @param cards   all vendor cards
   * @param txs     all transactions
   * @param expenses all expenses (each { amount, date|at })
   */
  function showReport(show, cards, txs, expenses) {
    const from = show.startedAt;
    const to   = show.endedAt || null;

    /* ── cards that left during the show ── */
    const left    = cards.filter(x => exitKind(x) && inWindow(exitTime(x), from, to));
    const sold    = left.filter(x => exitKind(x) === 'sale');
    const tradedOut = left.filter(x => exitKind(x) === 'trade');

    const cashIn      = sold.reduce((s, x) => s + c(x.soldPrice), 0);
    const soldAtMkt   = sold.reduce((s, x) => s + c(x.tcgPrice) * (parseInt(x.qty, 10) || 1), 0);
    const tradedValue = tradedOut.reduce((s, x) => s + c(exitVal(x)), 0);

    /* ── cards that arrived during the show ── */
    const gained = cards.filter(x => inWindow(x.acquiredAt || x.addedAt, from, to));
    const byTrade = gained.filter(x => x.acquiredVia === 'trade');
    const byCash  = gained.filter(x => x.acquiredVia !== 'trade');

    // Cost basis is what you actually gave up. Fall back to market only when
    // basis was never recorded, and flag it so the number isn't silently wrong.
    const missingBasis = byCash.filter(x => x.costBasis == null).length;
    const cashOutCards = byCash.reduce((s, x) => s + c(x.costBasis != null ? x.costBasis : 0), 0);
    const gainedMarket = gained.reduce((s, x) => s + c(x.tcgPrice) * (parseInt(x.qty, 10) || 1), 0);
    const tradeCredit  = byTrade.reduce((s, x) => s + c(x.costBasis), 0);
    const tradeMarket  = byTrade.reduce((s, x) => s + c(x.tcgPrice) * (parseInt(x.qty, 10) || 1), 0);

    /* ── expenses ── */
    const exp = (expenses || []).filter(e => {
      const t = e.at || (e.date ? new Date(e.date + 'T12:00').getTime() : null);
      return inWindow(t, from, to);
    });
    const expenseTotal = exp.reduce((s, e) => s + c(e.amount), 0) + c(show.fee);

    /* ── the money ── */
    const netCash   = cashIn - cashOutCards - expenseTotal;
    // What trading earned: market value acquired minus value handed over.
    const tradeSpread = tradeMarket - tradedValue;

    const openInv  = show.openInvValue != null ? c(show.openInvValue) : null;
    const closeInv = show.closeInvValue != null ? c(show.closeInvValue) : inventoryValueCents(cards);
    const invDelta = openInv == null ? null : closeInv - openInv;

    return {
      window: { from: from, to: to },
      soldCount: sold.length,
      tradedOutCount: tradedOut.length,
      gainedCount: gained.length,

      cashInCents: cashIn,
      soldAtMarketCents: soldAtMkt,
      pctOfMarket: soldAtMkt > 0 ? Math.round((cashIn / soldAtMkt) * 1000) / 10 : null,

      tradedOutValueCents: tradedValue,
      tradeCreditGivenCents: tradeCredit,
      tradeMarketInCents: tradeMarket,
      tradeSpreadCents: tradeSpread,

      cashSpentOnCardsCents: cashOutCards,
      cardsMissingBasis: missingBasis,
      gainedMarketCents: gainedMarket,

      expenseCents: expenseTotal,
      netCashCents: netCash,

      openInvCents: openInv,
      closeInvCents: closeInv,
      invDeltaCents: invDelta,

      // The bottom line: cash you kept plus what the inventory moved by.
      totalGainCents: invDelta == null ? null : netCash + invDelta,
      totalGainPct: (invDelta == null || openInv == null || openInv === 0)
        ? null
        : Math.round(((netCash + invDelta) / openInv) * 1000) / 10
    };
  }

  /** Anything that looks wrong enough to distrust the report. */
  function reportWarnings(r) {
    const w = [];
    if (r.openInvCents == null) w.push('No opening snapshot — inventory change unknown');
    if (r.cardsMissingBasis) w.push(r.cardsMissingBasis + ' acquired card(s) have no cost basis');
    if (r.soldCount === 0 && r.tradedOutCount === 0) w.push('Nothing recorded as sold or traded');
    return w;
  }

  const API = { inventoryValueCents, showReport, reportWarnings };
  if (typeof window !== 'undefined') window.ShowReport = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
