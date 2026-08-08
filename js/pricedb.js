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
  /* Strip a trailing collector number that some CSV exports staple to the name
   * ("Tyrunt - 070"). Applied to database records at load AND to every incoming
   * query, because a card saved while a suffixed export was live carries the
   * suffix in its own name — and would then match "Tyrunt - 070 (Pokemon Center
   * Exclusive)" more closely than plain "Tyrunt". */
  function stripNumberSuffix(s) {
    // Handles both "Tyrunt - 070" and "Tyrunt - 070 (Pokemon Center Exclusive)",
    // so the variant qualifier survives while the redundant number goes.
    return String(s == null ? '' : s)
      .replace(/\s+-\s+[0-9A-Za-z]+(?:\/[0-9A-Za-z]+)?(?=\s*[\(\[]|\s*$)/, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Normalise a record's name in place. Exports staple the collector number to
   * the name in two different shapes — "Tyrunt - 070" (English CSV) and
   * "Gloom 109 108" (JP builder). Both make the record match only as a partial,
   * which then loses to dozens of exact-name hits and falls off the result
   * limit entirely — the card becomes unfindable.
   */
  function cleanRecordName(r) {
    if (typeof r.n !== 'string') return;
    r.n = stripNumberSuffix(r.n);
    if (r.u) {
      const parts = String(r.u).split('/').map(x => x.replace(/^0+/, '') || '0').filter(Boolean);
      if (parts.length) {
        const pat = parts.map(x => '0*' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
        r.n = r.n.replace(new RegExp('\\s+' + pat + '(?=\\s|$)'), ' ').replace(/\s{2,}/g, ' ').trim();
      }
    }
  }

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

  // How well a database name matches the name we're looking up.
  // Many sets carry a plain printing and pricier qualified ones sharing the same
  // number — "Alakazam" #009 at $9 vs "Alakazam - 009 (Pokemon Center Exclusive)"
  // at $76, or "[Staff]", "(Cosmos Holo)", "(Pitch Black Stamped)". Without this
  // the priciest tiebreak silently upgrades a plain card to the variant.
  // 0 = same name, 1 = database name adds qualifiers, 2 = anything else.
  function variantRank(dbName, queryName) {
    const d = normName(dbName), q = normName(queryName);
    if (!q || d === q) return 0;
    if (d.startsWith(q)) return 1;
    return 2;
  }

  // Same idea one level up: setMatches() is deliberately loose, so "Base Set"
  // also matches "Base Set (Shadowless)" and "Base Set 2". An exact set name
  // must win, or every Base Set card gets priced as Shadowless.
  function setRank(dbSet, querySet) {
    if (!querySet) return 0;
    const A = normName(dbSet).replace(/^[a-z0-9]+:\s*/, '');
    const B = normName(querySet).replace(/^[a-z0-9]+:\s*/, '');
    if (A === B) return 0;
    return setMatches(dbSet, querySet) ? 1 : 2;
  }

  /* ---------- loading ---------- */

  // ---- Japanese database (built separately by enrich.html) ----
  let jpLoaded = false, jpLoading = null, jpAvailable = null;

  async function loadJP() {
    if (jpLoaded) return true;
    if (jpAvailable === false) return false;
    if (jpLoading) return jpLoading;
    jpLoading = (async () => {
      try {
        const res = await fetch('data/prices-jp.json');
        if (!res.ok) { jpAvailable = false; return false; }
        const data = await res.json();
        for (const r of data) {
          cleanRecordName(r);
          rows.push(r);
          if (r.i) byId.set(String(r.i), r);
          const key = normName(r.n);
          let b = nameIndex.get(key);
          if (!b) { b = []; nameIndex.set(key, b); }
          b.push(r);
        }
        jpLoaded = true; jpAvailable = true;
        console.log(`[PriceDB] +${data.length} Japanese printings`);
        return true;
      } catch (e) {
        jpAvailable = false;
        console.warn('[PriceDB] no Japanese database:', e.message);
        return false;
      } finally { jpLoading = null; }
    })();
    return jpLoading;
  }

  function hasJP() { return jpLoaded; }

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
          // Some CSV exports leave the collector number stapled to the name
          // ("Aegislash EX - 65a/119"). The number already lives in r.u, so
          // strip it — otherwise it shows up in search results and breaks
          // exact-name matching against cards stored without it.
          cleanRecordName(r);
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
      // r.pid is added by enrich.html, which resolves the real TCGplayer product id
      // via TCGCSV. The raw CSV only has SKU ids (one per condition), which cannot
      // address a product image — without a pid these stay null and the UI shows
      // a placeholder. The image URL is always derivable from the product id.
      image_url: r.pid ? `https://tcgplayer-cdn.tcgplayer.com/product/${r.pid}_200w.jpg` : null,
      tcgplayer_id: r.pid || null,
      sku_id: r.i ? Number(r.i) : null,
      market_price: price,
      printing: r.v || 'Normal',
      // NOTE: deliberately NOT named "condition" — that field belongs to the
      // user's card record and must never be overwritten by price metadata.
      priced_at_condition: usedCond,
      priced_condition_exact: exact,
      prices_by_condition: r.c || {},
      lows_by_condition: r.l || {},
      low_price: (r.l && (r.l[cond] != null ? r.l[cond] : r.l.NM)) != null
                 ? (r.l[cond] != null ? r.l[cond] : r.l.NM) : null,
      _jp: !!r.jp,
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
    name = stripNumberSuffix(name);
    const q = normName(name);
    if (!q) return [];

    const { number = '', set = '', limit = 60, condition = 'NM' } = opts;

    // 1) exact name bucket
    const exactBucket = nameIndex.get(q);
    const hits = exactBucket ? exactBucket.slice() : [];
    const seen = new Set(hits);

    // 2) ALSO gather partial matches, always — an exact hit on "charizard"
    //    must not hide "Charizard V" / "Charizard VMAX".
    for (const [key, bucket] of nameIndex) {
      if (key === q) continue;
      if (key.includes(q) || (q.length > 4 && q.includes(key))) {
        for (const rec of bucket) {
          if (seen.has(rec)) continue;
          seen.add(rec);
          hits.push(rec);
        }
        if (hits.length > 600) break;
      }
    }
    if (!hits.length) return [];
    const exactSet = new Set(exactBucket || []);

    const wantFull = fullNum(number);
    const wantPre = numPrefix(number);

    // Score: exact full number > number prefix > set match > price
    hits.sort((a, b) => {
      // exact name matches rank above partial ones
      const ae = exactSet.has(a) ? 0 : 1, be = exactSet.has(b) ? 0 : 1;
      if (ae !== be) return ae - be;
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
    name = stripNumberSuffix(name);
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
        // Name match first — a plain card must never be upgraded to a
        // qualified variant (Pokemon Center Exclusive / Staff / stamped)
        // sharing its number just because that variant is worth more.
        const vr = variantRank(a.name, name) - variantRank(b.name, name);
        if (vr !== 0) return vr;
        const sr = setRank(a.set_name, set) - setRank(b.set_name, set);
        if (sr !== 0) return sr;
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

  window.PriceDB = { load, loadJP, hasJP, search, lookup, byTcgId, isReady, stats, normName, normCond, priceFor };
})();
