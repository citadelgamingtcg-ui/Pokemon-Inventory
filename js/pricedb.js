/* ──────────────────────────────────────────────────────────────────────────
   pricedb.js — Local TCGPlayer price database
   Loads a compact snapshot of TCGPlayer NM prices (from a Pricing Custom
   Export CSV) and provides instant, rate-limit-free lookup + search.

   Falls back to the /search API for anything not in the snapshot
   (Japanese cards, sealed products, brand-new sets).

   Exposes: window.PriceDB
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const DATA_URL = 'data/prices.json';

  let rows = [];             // raw records
  let byId = new Map();      // tcgplayer id -> record
  let nameIndex = new Map(); // normalized name -> [records]
  let loaded = false;
  let loading = null;
  let meta = { count: 0, sets: 0, snapshot: null };

  /* ---------- normalization helpers ---------- */

  // Strip punctuation that varies between sources: apostrophes, hyphens,
  // and the trailing " ex"/"EX" casing differences.
  function normName(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[''`]/g, '')
      .replace(/[-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // "168/165" -> "168" ; "065a/119" -> "065a" ; strips leading zeros
  function numPrefix(n) {
    const first = String(n || '').replace(/^#/, '').split('/')[0].trim().toLowerCase();
    return first.replace(/^0+(?=[0-9])/, '');
  }

  function fullNum(n) {
    // Normalize "#004/100" and "4/100" to the same key
    const raw = String(n || '').replace(/^#/, '').replace(/\s/g, '').toLowerCase();
    const m = raw.match(/^([a-z]*)0*(\d+)([a-z]*)\/0*(\d+)([a-z]*)$/);
    return m ? `${m[1]}${m[2]}${m[3]}/${m[4]}${m[5]}` : raw;
  }

  // Compare set names loosely: "ME04: Chaos Rising" ~ "Chaos Rising"
  function setMatches(a, b) {
    const A = normName(a).replace(/^[a-z0-9]+:\s*/, '');
    const B = normName(b).replace(/^[a-z0-9]+:\s*/, '');
    if (!A || !B) return false;
    return A === B || A.includes(B) || B.includes(A);
  }

  /* ---------- loading ---------- */

  async function load() {
    if (loaded) return true;
    if (loading) return loading;

    loading = (async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error('prices.json ' + res.status);
        const data = await res.json();

        rows = data;
        byId = new Map();
        nameIndex = new Map();
        const sets = new Set();

        for (const r of rows) {
          if (r.i) byId.set(String(r.i), r);
          sets.add(r.s);
          const key = normName(r.n);
          let bucket = nameIndex.get(key);
          if (!bucket) { bucket = []; nameIndex.set(key, bucket); }
          bucket.push(r);
        }

        meta = { count: rows.length, sets: sets.size, snapshot: null };
        loaded = true;
        console.log(`[PriceDB v2 · conditions] loaded ${rows.length} printings across ${sets.size} sets — sample keys: ${Object.keys(rows[0]?.c||{}).join('/')}`);
        return true;
      } catch (e) {
        console.warn('[PriceDB] load failed:', e.message);
        loaded = false;
        return false;
      } finally {
        loading = null;
      }
    })();

    return loading;
  }

  /* ---------- shaping ---------- */

  // Convert an internal record into the same shape /search returns,
  // so existing UI code can consume it unchanged.
  const COND_ORDER = ['NM', 'LP', 'MP', 'HP', 'DMG'];

  // Normalize whatever the app stored ("NM", "Near Mint", "lightly played"...)
  function normCond(c) {
    const t = (c || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!t) return 'NM';
    if (t.startsWith('NM') || t.startsWith('NEARMINT')) return 'NM';
    if (t.startsWith('LP') || t.startsWith('LIGHTLY'))  return 'LP';
    if (t.startsWith('MP') || t.startsWith('MODERATE')) return 'MP';
    if (t.startsWith('HP') || t.startsWith('HEAVILY'))  return 'HP';
    if (t.startsWith('DMG') || t.startsWith('DAMAGED')) return 'DMG';
    return 'NM';
  }

  // Price for a condition; falls back to the nearest better condition present.
  function priceFor(rec, cond) {
    const c = rec.c || {};
    const want = normCond(cond);
    if (c[want] != null) return { price: c[want], cond: want, exact: true };
    const i = COND_ORDER.indexOf(want);
    for (let j = i - 1; j >= 0; j--) if (c[COND_ORDER[j]] != null) return { price: c[COND_ORDER[j]], cond: COND_ORDER[j], exact: false };
    for (let j = i + 1; j < COND_ORDER.length; j++) if (c[COND_ORDER[j]] != null) return { price: c[COND_ORDER[j]], cond: COND_ORDER[j], exact: false };
    return { price: null, cond: null, exact: false };
  }

  function toCard(r, cond) {
    const { price, cond: usedCond, exact } = priceFor(r, cond);
    return {
      name: r.n,
      set_name: r.s,
      number: r.u,
      rarity: r.r,
      image_url: r.i ? `https://tcgplayer-cdn.tcgplayer.com/product/${r.i}_200w.jpg` : null,
      tcgplayer_id: r.i ? Number(r.i) : null,
      market_price: price,
      low_price: price,
      printing: r.v || 'Normal',
      // NOTE: deliberately NOT named "condition" — that field belongs to the
      // user's card record and must never be overwritten by price metadata.
      priced_at_condition: usedCond,
      priced_condition_exact: exact,
      prices_by_condition: r.c || {},
      _local: true
    };
  }

  /* ---------- search ---------- */

  /**
   * Find every printing matching a card name.
   * @param {string} name
   * @param {object} opts { number, set, limit }
   * @returns {Array} cards in /search response shape, best matches first
   */
  function search(name, opts = {}) {
    if (!loaded) return [];
    const q = normName(name);
    if (!q) return [];

    const { number = '', set = '', limit = 60, condition = 'NM' } = opts;

    // 1) exact name bucket
    let hits = nameIndex.get(q) ? nameIndex.get(q).slice() : [];

    // 2) if nothing exact, scan for partial matches (slower path)
    if (!hits.length) {
      for (const [key, bucket] of nameIndex) {
        if (key.includes(q) || (q.length > 4 && q.includes(key))) {
          hits.push(...bucket);
          if (hits.length > 400) break;
        }
      }
    }
    if (!hits.length) return [];

    const wantFull = fullNum(number);
    const wantPre = numPrefix(number);

    // Score: exact full number > number prefix > set match > price
    hits.sort((a, b) => {
      if (wantFull) {
        const af = fullNum(a.u) === wantFull ? 0 : 1;
        const bf = fullNum(b.u) === wantFull ? 0 : 1;
        if (af !== bf) return af - bf;
      }
      if (wantPre) {
        const ap = numPrefix(a.u) === wantPre ? 0 : 1;
        const bp = numPrefix(b.u) === wantPre ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      if (set) {
        const as = setMatches(a.s, set) ? 0 : 1;
        const bs = setMatches(b.s, set) ? 0 : 1;
        if (as !== bs) return as - bs;
      }
      // Prefer the plainer printing (Normal/Holofoil) over Reverse Holofoil
      // unless the caller explicitly asked for reverse.
      const wantRev = /reverse/i.test(opts.printing || '');
      const rank = r => {
        const v = (r.v || 'Normal').toLowerCase();
        if (wantRev) return v.includes('reverse') ? 0 : 1;
        if (v.includes('reverse')) return 2;
        if (v.includes('1st edition')) return 1;
        return 0;                       // Normal / Holofoil
      };
      const ar = rank(a), br = rank(b);
      if (ar !== br) return ar - br;
      return (priceFor(b, condition).price || 0) - (priceFor(a, condition).price || 0);
    });

    return hits.slice(0, limit).map(r => toCard(r, condition));
  }

  /**
   * Resolve ONE card confidently. Returns null unless we're sure.
   * Used by price-refresh so a bad match can never overwrite good data.
   */
  function lookup(name, number, set, condition) {
    if (!loaded) return null;
    const candidates = search(name, { number, set, limit: 40, condition });
    if (!candidates.length) return null;

    const wantFull = fullNum(number);
    const wantPre = numPrefix(number);

    // Require a number match when the card has a number.
    if (number) {
      let exact = candidates.filter(c => fullNum(c.number) === wantFull);
      if (!exact.length) exact = candidates.filter(c => numPrefix(c.number) === wantPre);
      if (!exact.length) return null;             // no confident match -> skip

      if (exact.length > 1 && set) {
        const inSet = exact.filter(c => setMatches(c.set_name, set));
        if (inSet.length) exact = inSet;
      }
      // Prefer base printings (Normal/Holofoil) over Reverse Holofoil / 1st Ed,
      // then take the priciest among equals.
      const rank = c => {
        const v = (c.printing || 'Normal').toLowerCase();
        if (v.includes('reverse')) return 2;
        if (v.includes('1st edition')) return 1;
        return 0;
      };
      exact.sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return (b.market_price || 0) - (a.market_price || 0);
      });
      return exact[0];
    }

    // No number: only accept an exact-name single hit
    const q = normName(name);
    const exactName = candidates.filter(c => normName(c.name) === q);
    if (!exactName.length) return null;
    if (set) {
      const inSet = exactName.filter(c => setMatches(c.set_name, set));
      if (inSet.length) return inSet[0];
    }
    return exactName[0];
  }

  function byTcgId(id, condition) {
    const r = byId.get(String(id));
    return r ? toCard(r, condition) : null;
  }

  function isReady() { return loaded; }
  function stats() { return { ...meta, loaded }; }

  window.PriceDB = { load, search, lookup, byTcgId, isReady, stats, normName, normCond, priceFor };
})();
