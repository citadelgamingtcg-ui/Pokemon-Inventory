/* Paragon Collectibles — point-of-sale maths
 *
 * Every amount is handled as integer cents internally. Floats silently drift
 * (0.1 + 0.2), and an allocation that doesn't sum back to the agreed total
 * would quietly corrupt per-card profit on every discounted bundle.
 *
 * No DOM, no app state — pass plain objects in, get plain objects out.
 */
(function () {
  'use strict';

  const CREDIT_RATE = 0.80;   // a $100 card earns $80 of trade credit

  const toCents = v => Math.round((Number(v) || 0) * 100);
  const toDollars = c => Math.round(c) / 100;
  const money = c => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2);

  /** What a card is listed at: asking price if set, else market. */
  function listedCents(card) {
    const ask = Number(card && card.askingPrice) || 0;
    const mkt = Number(card && card.tcgPrice) || 0;
    return toCents(ask > 0 ? ask : mkt);
  }

  /* ── bulk items ──
   * A "$5 binder" is one record standing for many cards at one price. Selling
   * three of them decrements the quantity; it does not retire the record. Cart
   * entries therefore carry a unit count, and the pricing maths sees each unit
   * as its own line so allocation stays honest.
   */
  const isBulk = card => !!(card && card.bulk);
  const unitsOf = e => Math.max(1, parseInt(e && e.units, 10) || 1);
  const stockOf = card => Math.max(0, parseInt(card && card.qty, 10) || (isBulk(card) ? 0 : 1));

  /** Cart entries -> one line per unit, for allocation. */
  function expandCart(entries) {
    const out = [];
    for (const e of entries || []) {
      const n = unitsOf(e);
      for (let i = 0; i < n; i++) out.push(e);
    }
    return out;
  }

  /** Allocated lines summed back per card, for persistence. */
  function groupLines(lines) {
    const by = new Map();
    for (const l of lines || []) {
      const k = l.cardId;
      const g = by.get(k) || { cardId: k, name: l.name, units: 0, listedCents: 0, allocatedCents: 0 };
      g.units += 1;
      g.listedCents += l.listedCents;
      g.allocatedCents += l.allocatedCents;
      by.set(k, g);
    }
    return [...by.values()];
  }

  /**
   * Split `totalCents` across items in proportion to their listed price.
   *
   * Uses largest-remainder so the parts always sum to exactly the total —
   * naive rounding leaves stray cents that make a bundle's parts disagree
   * with what the customer actually paid.
   */
  function allocate(items, totalCents) {
    const n = items.length;
    if (!n) return [];
    const weights = items.map(listedCents);
    const sum = weights.reduce((a, b) => a + b, 0);
    // No prices to weight by (all zero) — split evenly.
    const w = sum > 0 ? weights : items.map(() => 1);
    const wSum = sum > 0 ? sum : n;

    const exact = w.map(x => (totalCents * x) / wSum);
    const floors = exact.map(Math.floor);
    let remainder = totalCents - floors.reduce((a, b) => a + b, 0);

    const order = exact
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);

    const out = floors.slice();
    for (let k = 0; k < order.length && remainder > 0; k++, remainder--) out[order[k].i]++;
    // Negative totals shouldn't happen, but never hand back a broken split.
    while (remainder < 0) {
      for (let k = order.length - 1; k >= 0 && remainder < 0; k--) {
        if (out[order[k].i] > 0) { out[order[k].i]--; remainder++; }
      }
      break;
    }
    return out;
  }

  /**
   * A sale. `total` omitted means full asking price; pass a haggled total and
   * the discount spreads pro-rata.
   */
  function saleSummary(cards, total) {
    const listed = cards.reduce((s, c) => s + listedCents(c), 0);
    const agreed = total == null ? listed : toCents(total);
    const parts = allocate(cards, agreed);
    return {
      type: 'sale',
      count: cards.length,
      listedCents: listed,
      totalCents: agreed,
      discountCents: listed - agreed,
      pctOfAsk: listed > 0 ? Math.round((agreed / listed) * 1000) / 10 : null,
      lines: cards.map((c, i) => ({
        cardId: c.id, name: c.name,
        listedCents: listedCents(c),
        allocatedCents: parts[i]
      })),
      cashDeltaCents: agreed
    };
  }

  /** Trade credit for a card the customer brings in. */
  function creditCents(marketValue, rate) {
    return Math.round(toCents(marketValue) * (rate == null ? CREDIT_RATE : rate));
  }

  /**
   * A trade. `out` are your cards leaving, `incoming` are theirs arriving.
   * `total` optionally overrides the value your side goes out at (haggling).
   *
   * cashDelta > 0 -> customer owes you that much cash
   * cashDelta < 0 -> you owe them cash, or they carry the credit forward
   */
  function tradeSummary(out, incoming, opts) {
    const o = opts || {};
    const rate = o.rate == null ? CREDIT_RATE : o.rate;
    const listed = out.reduce((s, c) => s + listedCents(c), 0);
    const agreed = o.total == null ? listed : toCents(o.total);
    const parts = allocate(out, agreed);

    const inLines = (incoming || []).map(c => {
      const market = toCents(c.market != null ? c.market : c.tcgPrice);
      const credit = c.credit != null ? toCents(c.credit) : Math.round(market * rate);
      return {
        name: c.name, set: c.set, number: c.number, condition: c.condition,
        marketCents: market, creditCents: credit,
        spreadCents: market - credit
      };
    });
    const inCredit = inLines.reduce((s, l) => s + l.creditCents, 0);
    const inMarket = inLines.reduce((s, l) => s + l.marketCents, 0);

    return {
      type: 'trade',
      status: inLines.length ? 'closed' : 'open',
      rate: rate,
      listedCents: listed,
      outTotalCents: agreed,
      pctOfAsk: listed > 0 ? Math.round((agreed / listed) * 1000) / 10 : null,
      outLines: out.map((c, i) => ({
        cardId: c.id, name: c.name,
        listedCents: listedCents(c),
        allocatedCents: parts[i]
      })),
      inLines: inLines,
      inCreditCents: inCredit,
      inMarketCents: inMarket,
      // What the trade actually earned you: market value acquired minus value given up.
      spreadCents: inMarket - agreed,
      cashDeltaCents: agreed - inCredit
    };
  }

  /** Plain-English reading of the cash boot, for the confirm screen. */
  function cashLabel(cents) {
    if (cents > 0) return 'Customer pays ' + money(cents);
    if (cents < 0) return 'You owe ' + money(-cents) + ' (cash or credit)';
    return 'Even trade';
  }

  /* ── condition pricing ──
   * Local records carry the full NM/LP/MP/HP/DMG ladder, so a condition change
   * re-prices from real data. Japanese records only store a single market
   * price, and some English printings are missing rungs — those fall back to
   * multipliers, and the caller is told the price was estimated rather than read.
   */
  const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
  const CONDITION_LABELS = {
    NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played',
    HP: 'Heavily Played', DMG: 'Damaged'
  };
  const CONDITION_FALLBACK = { NM: 1, LP: 0.85, MP: 0.70, HP: 0.55, DMG: 0.40 };

  /**
   * @returns {{price:number, exact:boolean, from:string}}
   *   exact=false means it was derived from a multiplier, not looked up.
   */
  function priceAtCondition(ladder, cond, nmPrice) {
    const want = String(cond || 'NM').toUpperCase();
    const l = ladder || {};
    const direct = Number(l[want]);
    if (direct > 0) return { price: Math.round(direct * 100) / 100, exact: true, from: want };

    // Work down from the nearest better condition we actually have.
    const idx = CONDITIONS.indexOf(want);
    for (let i = idx - 1; i >= 0; i--) {
      const have = Number(l[CONDITIONS[i]]);
      if (have > 0) {
        const ratio = CONDITION_FALLBACK[want] / CONDITION_FALLBACK[CONDITIONS[i]];
        return { price: Math.round(have * ratio * 100) / 100, exact: false, from: CONDITIONS[i] };
      }
    }
    const base = Number(nmPrice) || Number(l.NM) || 0;
    return {
      price: Math.round(base * (CONDITION_FALLBACK[want] || 1) * 100) / 100,
      exact: false, from: 'NM'
    };
  }

  /** Every condition priced, for a dropdown that shows what each is worth. */
  function conditionOptions(ladder, nmPrice) {
    return CONDITIONS.map(k => {
      const r = priceAtCondition(ladder, k, nmPrice);
      return { code: k, label: CONDITION_LABELS[k], price: r.price, exact: r.exact };
    });
  }

  /* ── pricing ──
   * The TCGplayer export gives a market price (weighted average of recent
   * SALES) and the lowest current listing. It does NOT contain individual
   * listings, so a trimmed mean of the cheapest few can't be computed from it.
   *
   * What the two numbers do reveal is the shape you're eyeballing manually: a
   * low sitting far under market is the outlier listing you skip. Close to
   * market means the cheap copies are the real market.
   */
  function suggestPrice(market, low, opts) {
    const o = opts || {};
    const m = Number(market) || 0;
    const l = Number(low) || 0;
    const floor = o.outlierFloor == null ? 0.70 : o.outlierFloor;  // low below this share of market = outlier
    const over = o.overLow == null ? 1.03 : o.overLow;             // sit just above the cheapest real listing

    if (!m && !l) return { price: 0, basis: 'none', outlier: false };
    if (!l) return { price: m, basis: 'market', outlier: false };
    if (!m) return { price: l, basis: 'low', outlier: false };

    const ratio = l / m;
    if (ratio < floor) {
      // The cheapest copy is far below what things actually sell for — damaged,
      // mis-listed, or a lone dumper. Price off market instead.
      return { price: round2(m), basis: 'market (low looks like an outlier)', outlier: true, ratio: round2(ratio) };
    }
    // Undercut market slightly by sitting just above the cheapest genuine listing.
    return { price: round2(Math.min(m, l * over)), basis: 'just above lowest listing', outlier: false, ratio: round2(ratio) };
  }
  const round2 = v => Math.round(v * 100) / 100;

  /* ── card search ──
   * A name alone returns a hundred Charmanders. Let the number ride along in
   * the same box: "charmander 04/208", "charmander #044", "charmander, paldean
   * fates". Parsed here so the POS, the audit page and anything later all
   * behave identically.
   */
  function parseQuery(raw) {
    let text = String(raw || '').trim();
    let set = '';

    // Everything after a comma is a set hint: "charmander, paldean fates"
    const comma = text.indexOf(',');
    if (comma > -1) { set = text.slice(comma + 1).trim(); text = text.slice(0, comma).trim(); }

    let number = '';
    const patterns = [
      /\b(\d{1,4}\s*\/\s*\d{1,4}[a-z]?)\b/i,   // 04/208, 168/165
      /#\s*([0-9a-z]{1,6})\b/i,                   // #044, #TG12
      /\b([a-z]{1,3}\d{1,3})\b/i,                 // TG12, SV044
      /\s(\d{1,4})$/                              // trailing bare number
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) { number = m[1].replace(/\s+/g, ''); text = text.replace(m[0], ' '); break; }
    }
    return { name: text.replace(/\s+/g, ' ').trim(), number: number, set: set };
  }

  const numKey = n => String(n || '').split('/')[0].replace(/^0+/, '').toLowerCase();

  /**
   * Local database first, API only as a fallback. Returns records already
   * carrying image_url, so results can be confirmed visually.
   */
  async function findCards(raw, opts) {
    const o = opts || {};
    const limit = o.limit || 40;
    const q = parseQuery(raw);
    if (!q.name && !q.number) return { cards: [], query: q, source: 'none' };

    let cards = [];
    let jpReady = false;
    const PDB = typeof window !== 'undefined' ? window.PriceDB : null;
    if (PDB) {
      try {
        if (!PDB.isReady()) await PDB.load();
        // The Japanese database is 3MB and loads lazily — it must be in before
        // the search runs, not after, or the first JP query silently misses.
        if (o.japanese && PDB.loadJP) jpReady = await PDB.loadJP();
        cards = PDB.search(q.name, { number: q.number, set: q.set, limit: 600 }) || [];
      } catch (e) { cards = []; }
    }

    // JP and EN share one index once loaded, so keep the two apart explicitly.
    if (cards.length) {
      cards = o.japanese ? cards.filter(c => c._jp) : cards.filter(c => !c._jp);
    }

    // A supplied number should narrow, not merely re-rank — but never to nothing.
    if (q.number && cards.length) {
      const want = numKey(q.number);
      const exact = cards.filter(c => numKey(c.number) === want);
      if (exact.length) cards = exact;
    }
    if (q.set && cards.length) {
      const s = q.set.toLowerCase();
      const inSet = cards.filter(c => (c.set_name || '').toLowerCase().includes(s));
      if (inSet.length) cards = inSet;
    }

    let source = 'local';
    if (!cards.length && typeof fetch === 'function') {
      try {
        const url = '/search?q=' + encodeURIComponent(q.name) +
                    (q.number ? '&number=' + encodeURIComponent(q.number) : '') +
                    (o.japanese ? '&jp=1' : '');
        const r = await fetch(url);
        if (r.ok) { cards = (await r.json()).data || []; source = 'api'; }
      } catch (e) { /* leave empty */ }
    }
    return {
      cards: cards.slice(0, limit), query: q, source: source,
      total: cards.length, japanese: !!o.japanese, jpReady: jpReady
    };
  }

  /** Distinct sets across a result list, for a narrowing dropdown. */
  function setsIn(cards) {
    const seen = new Map();
    for (const c of cards || []) {
      const k = c.set_name || '';
      if (k) seen.set(k, (seen.get(k) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  const API = {
    CREDIT_RATE, toCents, toDollars, money,
    listedCents, allocate, saleSummary, creditCents, tradeSummary, cashLabel,
    isBulk, unitsOf, stockOf, expandCart, groupLines,
    parseQuery, findCards, setsIn, suggestPrice,
    CONDITIONS, CONDITION_LABELS, priceAtCondition, conditionOptions
  };
  if (typeof window !== 'undefined') window.POS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
