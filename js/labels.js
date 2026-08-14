/* Paragon Collectibles — price tag engine
 *
 * Generates ZPL II for the Zebra ZD421d (203 dpi) on 3" x 1.5" stock,
 * renders a pixel-accurate preview from the SAME constants, and talks to
 * Zebra Browser Print.
 *
 * Nothing here touches the DOM except drawPreview(), and nothing here
 * reads app state — pass plain card objects in. That is what makes it
 * testable in node without a printer.
 */
(function () {
  'use strict';

  /* ---------- layout (all values in printer dots @ 203 dpi) ---------- */

  const PROFILES = {
    /* 3" x 1.5" — back-of-toploader tag, 1D barcode */
    std: {
      id: 'std', label: '3" x 1.5"', width: 609, height: 304,
      speed: 4, darkness: 8,
      header:  { h: 48, textX: 18, textY: 8, font: 32 },
      name:    { x: 16, y: 62, field: 577, tiers: [[18,38],[24,32],[30,28],[999,24]] },
      setline: { x: 16, y: 112, field: 430, font: 24 },
      cond:    { x: 478, y: 104, w: 80, h: 36, font: 26 },
      code:    { type: '1d', x: 16, y: 154, h: 62, module: 2, textX: 16, textY: 224, textFont: 22 },
      price:   { x: 300, field: 293, bottom: 40, tiers: [[6,84],[7,76],[9,58],[999,46]] }
    },
    /* 1.25" x 1" — front-of-toploader tag, QR. Leaves the card art visible. */
    small: {
      id: 'small', label: '1.25" x 1"', width: 254, height: 203,
      speed: 4, darkness: 8,
      header:  { h: 26, textX: 7, textY: 4, font: 15 },
      name:    { x: 7, y: 31, field: 238, tiers: [[22,18],[27,15],[34,12],[999,11]] },
      setline: { x: 7, y: 54, field: 238, font: 13 },
      cond:    { x: 183, y: 146, w: 60, h: 22, font: 15 },
      code:    { type: 'qr', x: 183, y: 76, magnification: 3, ecc: 'M', textX: 7, textY: 150, textFont: 13 },
      price:   { x: 7, field: 168, top: 84, tiers: [[5,52],[6,46],[7,40],[999,34]] }
    },
    /* 1" x 0.5" — 203 x 102 dots. The QR alone is 63 of those 102, so there is
     * no room for the card name or the set/number. Price, condition, QR, id. */
    /* 1" x 0.5" — 203 x 102 dots. No brand bar: black text on white can't be
     * clipped by top-of-form drift, prints far faster, and reads cleaner at
     * this size. Content is centred with real margins top and bottom. */
    mini: {
      id: 'mini', label: '1" x 0.5" (wordmark)', width: 203, height: 102,
      speed: 4, darkness: 8, brand: 'text',
      header:  { y: 8, font: 12, centered: true },
      name:    null,
      setline: null,
      cond:    { x: 84, y: 72, w: 56, h: 20, font: 15 },
      // Outlined, not filled — a trait is desirable, the condition badge is
      // factual. Different weight keeps them from reading as the same thing.
      trait:   { x: 144, y: 72, w: 55, h: 20, font: 12 },
      code:    { type: 'qr', x: 12, y: 26, magnification: 3, ecc: 'M', showText: false },
      price:   { x: 84, field: 107, top: 28,
                 tiers: [[3,42],[4,40],[5,36],[6,30],[7,26],[9,21],[999,18]] }
    },
    /* Same, with the diamond mark ahead of the wordmark. */
    miniDiamond: {
      id: 'miniDiamond', label: '1" x 0.5" (diamond)', width: 203, height: 102,
      speed: 4, darkness: 8, brand: 'text',
      header:  { y: 8, font: 12, centered: true, solidMark: true },
      name:    null,
      setline: null,
      cond:    { x: 84, y: 72, w: 56, h: 20, font: 15 },
      code:    { type: 'qr', x: 12, y: 26, magnification: 3, ecc: 'M', showText: false },
      price:   { x: 84, field: 107, top: 28,
                 tiers: [[3,42],[4,40],[5,36],[6,30],[7,26],[9,21],[999,18]] }
    }
  };

  /* 18x18 block: black square with a white diamond knocked out. Drawn as a
   * bitmap because ZPL has no filled-diamond primitive, and inverted so it
   * sits seamlessly on top of the brand bar or the spine. */
  const DIAMOND = { w: 18, h: 18, bytesPerRow: 3, total: 54,
    hex: 'FFFFC0FF3FC0FE1FC0FE1FC0FC0FC0F807C0F003C0F003C0E001C0E001C0F003C0F003C0F807C0FC0FC0FE1FC0FE1FC0FF3FC0FFFFC0' };

  /* Solid diamond for use on white, where there's no bar to knock it out of. */
  const DIAMOND_SOLID = { w: 16, h: 16, bytesPerRow: 2, total: 32,
    hex: '0000018003C007E007E00FF01FF83FFC3FFC1FF80FF007E007E003C001800000' };

  const BRAND = 'PARAGON COLLECTIBLES';
  const DEFAULT_PROFILE = 'std';
  const profile = k => {
    if (k && !PROFILES[k]) {
      // Almost always a stale cached copy of this file against a newer page.
      console.warn('[Labels] unknown profile "' + k + '" — falling back to ' +
                   DEFAULT_PROFILE + '. This build knows: ' + Object.keys(PROFILES).join(', '));
    }
    return PROFILES[k] || PROFILES[DEFAULT_PROFILE];
  };

  // Zebra scalable font 0 is proportional; 0.58 is a deliberately
  // conservative average so fitted text never overruns its ^FB field.
  const CHAR_RATIO = 0.58;

  const textWidth = (s, pt) => Math.round((s || '').length * pt * CHAR_RATIO);

  /** Largest font from a tier table that still fits the field. */
  function fitFont(text, field, tiers) {
    const n = (text || '').length;
    for (const [maxChars, pt] of tiers) {
      if (n <= maxChars && textWidth(text, pt) <= field) return pt;
    }
    const last = tiers[tiers.length - 1][1];
    let pt = last;
    while (pt > 12 && textWidth(text, pt) > field) pt -= 2;
    return pt;
  }

  /**
   * Font + text that are guaranteed to fit. Shrinking stops at 12pt to stay
   * readable, so a pathologically long name gets clipped with an ellipsis
   * rather than silently running off the edge of the label.
   */
  function fitText(text, field, tiers) {
    const s = String(text == null ? '' : text);
    const font = fitFont(s, field, tiers);
    if (textWidth(s, font) <= field) return { text: s, font: font, truncated: false };
    const max = Math.max(1, Math.floor(field / (font * CHAR_RATIO)) - 3);
    return { text: s.slice(0, max).trimEnd() + '...', font: font, truncated: true };
  }

  /* ---------- ZPL text encoding ---------- */

  // ^ ~ and the ^FH escape char itself break a ^FD field, and Zebra needs
  // non-ASCII delivered as UTF-8 hex. ^FH + _XX covers both.
  function encodeFD(s) {
    const bytes = new TextEncoder().encode(String(s == null ? '' : s));
    let out = '';
    for (const b of bytes) {
      const ch = String.fromCharCode(b);
      if (b < 0x20 || b > 0x7e || ch === '^' || ch === '~' || ch === '_') {
        out += '_' + b.toString(16).toUpperCase().padStart(2, '0');
      } else {
        out += ch;
      }
    }
    return out;
  }

  /* ---------- tag IDs ---------- */

  const TAG_PREFIX = 'PC-';
  const formatTagId = n => TAG_PREFIX + String(n).padStart(5, '0');

  /** Highest tag number already issued across a card list. */
  function highestTagNumber(cards) {
    let max = 0;
    for (const c of cards || []) {
      const m = /^PC-(\d+)$/.exec(c && c.tagId || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  }

  /**
   * Assign tag IDs to any cards missing one. Returns { assigned, next }
   * where assigned is [{card, tagId}] so the caller can persist them.
   * Firestore doc ids are 20 chars and encode to ~510 dots of Code 128 —
   * far wider than the 262 dots available — hence the short serial.
   */
  function assignTagIds(allCards, targets) {
    let next = highestTagNumber(allCards) + 1;
    const assigned = [];
    for (const card of targets || []) {
      if (card.tagId) continue;
      const tagId = formatTagId(next++);
      assigned.push({ card, tagId });
    }
    return { assigned, next };
  }

  /* ---------- money / text helpers ---------- */

  function formatPrice(v) {
    const n = Number(v) || 0;
    // Whole-dollar prices print whole — "$34", not "$34.00". Cents appear only
    // when the price actually has them, and only below $100 where they matter.
    if (Number.isInteger(n)) return '$' + n.toLocaleString('en-US');
    return n < 100
      ? '$' + n.toFixed(2)
      : '$' + Math.round(n).toLocaleString('en-US');
  }

  /** Short badge text: the variant if present, else the condition. */
  const VARIANT_BADGE = {
    sealed: 'SEALED', '1st edition': '1ST ED', 'reverse holo': 'REV HOLO',
    staff: 'STAFF', 'promo pack': 'SEALED', 'error': 'ERROR'
  };
  function badgeText(card) {
    const v = (card && card.variant || '').trim();
    if (v) return (VARIANT_BADGE[v.toLowerCase()] || v).toUpperCase().slice(0, 8);
    return (card && card.condition || 'NM').toUpperCase().slice(0, 6);
  }

  /** Desirable traits — a swirl is worth real money on a vintage holo and is
   *  invisible on a tag unless it's stated. Separate from condition: a card
   *  can be NM and swirled, or LP and swirled. */
  const TRAIT_BADGE = { swirl: 'SWIRL', miscut: 'MISCUT', 'off-center': 'OFF-CTR', crimp: 'CRIMP', 'no swirl': '' };
  function traitText(card) {
    const t = (card && card.trait || '').trim();
    if (!t) return '';
    return (TRAIT_BADGE[t.toLowerCase()] !== undefined ? TRAIT_BADGE[t.toLowerCase()] : t).toUpperCase().slice(0, 8);
  }

  function setLine(card) {
    const set = (card.set || '').trim();
    const num = (card.number || '').trim();
    if (set && num) return set + '  #' + num;
    return set || (num ? '#' + num : '');
  }

  /** The price a tag should show: asking if set, else market. */
  const tagPrice = card =>
    (Number(card.askingPrice) > 0 ? Number(card.askingPrice) : Number(card.tcgPrice)) || 0;

  /* ---------- ZPL ---------- */

  /** Payload encoded into the barcode/QR. 1D can't carry the prefix at 1.25". */
  function codePayload(tagId, P) {
    const t = String(tagId || '');
    if (P.code.type === '1d' && P.width < 400) {
      const m = /(\d+)$/.exec(t);
      return m ? m[1] : t;   // "PC-04127" -> "04127", 246 dots -> 180
    }
    return t;
  }

  /** One label. `card` needs: name, set, number, condition, tagId, and a price. */
  function buildLabel(card, opts) {
    const o = opts || {};
    const P = profile(o.profile);
    const name = (card.name || '').trim();
    const sl = setLine(card);
    // A sealed promo is the same card in a different product. When a variant is
    // set it takes the badge, because "SEALED" is what changes the price —
    // the condition underneath is unremarkable by comparison.
    const cond = badgeText(card);
    const price = formatPrice(o.price != null ? o.price : tagPrice(card));
    const tag = card.tagId || '';

    const nameFit = P.name ? fitText(name, P.name.field, P.name.tiers)
                           : { text: '', font: 0, truncated: false };
    const setFit = P.setline ? fitText(sl, P.setline.field, [[999, P.setline.font]])
                             : { text: '', font: 0, truncated: false };
    const priceFont = fitFont(price, P.price.field, P.price.tiers);
    const nameY = P.name ? P.name.y + Math.round((P.name.tiers[0][1] - nameFit.font) * 0.45) : 0;
    const priceY = P.price.top != null ? P.price.top : (P.height - P.price.bottom - priceFont);

    const z = [];
    z.push('^XA', '^CI28', '^PW' + P.width, '^LL' + P.height, '^LH0,0',
           '^PR' + P.speed, '^MD' + (o.darkness != null ? o.darkness : P.darkness));

    const mark = (x, y) =>
      `^FO${x},${y}^GFA,${DIAMOND.total},${DIAMOND.total},${DIAMOND.bytesPerRow},${DIAMOND.hex}^FS`;

    if (P.brand === 'spine') {
      // Vertical black bar with the diamond and no wordmark.
      z.push(`^FO0,0^GB${P.header.w},${P.height},${P.header.w}^FS`);
      z.push(mark(P.header.mark.x, P.header.mark.y));
    } else if (P.brand === 'text') {
      // Plain black wordmark, optionally with the diamond ahead of it.
      const d = DIAMOND_SOLID;
      const gap = 6;
      const textW = textWidth(BRAND, P.header.font);
      const blockW = textW + (P.header.solidMark ? d.w + gap : 0);
      const x0 = P.header.centered ? Math.max(2, Math.round((P.width - blockW) / 2)) : (P.header.x || 6);
      if (P.header.solidMark) {
        z.push(`^FO${x0},${P.header.y + Math.round((P.header.font - d.h) / 2)}^GFA,${d.total},${d.total},${d.bytesPerRow},${d.hex}^FS`);
      }
      const tx = x0 + (P.header.solidMark ? d.w + gap : 0);
      z.push(`^FO${tx},${P.header.y}^A0N,${P.header.font},${P.header.font}^FH^FD${encodeFD(BRAND)}^FS`);
    } else {
      const hy = P.header.y || 0;
      z.push(`^FO0,${hy}^GB${P.width},${P.header.h},${P.header.h}^FS`);
      if (P.header.mark) z.push(mark(P.header.mark.x, P.header.mark.y));
      z.push(`^FO${P.header.textX},${P.header.textY}^A0N,${P.header.font},${P.header.font}^FR^FH^FD${encodeFD(BRAND)}^FS`);
    }

    if (P.name && nameFit.text) {
      z.push(`^FO${P.name.x},${nameY}^A0N,${nameFit.font},${nameFit.font}^FB${P.name.field},1,0,L^FH^FD${encodeFD(nameFit.text)}^FS`);
    }
    if (P.setline && setFit.text) {
      z.push(`^FO${P.setline.x},${P.setline.y}^A0N,${setFit.font},${setFit.font}^FB${P.setline.field},1,0,L^FH^FD${encodeFD(setFit.text)}^FS`);
    }

    if (cond) {
      // "SEALED" is longer than "NM", so the font shrinks to fit rather than
      // running off the end of the badge.
      let cf = P.cond.font;
      while (cf > 8 && textWidth(cond, cf) > P.cond.w - 8) cf -= 1;
      z.push(`^FO${P.cond.x},${P.cond.y}^GB${P.cond.w},${P.cond.h},${P.cond.h}^FS`);
      const cx = P.cond.x + Math.round((P.cond.w - textWidth(cond, cf)) / 2);
      z.push(`^FO${cx},${P.cond.y + Math.round((P.cond.h - cf) / 2) + 1}^A0N,${cf},${cf}^FR^FH^FD${encodeFD(cond)}^FS`);
    }

    const trait = traitText(card);
    if (trait && P.trait) {
      let tf = P.trait.font;
      while (tf > 7 && textWidth(trait, tf) > P.trait.w - 8) tf -= 1;
      z.push(`^FO${P.trait.x},${P.trait.y}^GB${P.trait.w},${P.trait.h},2^FS`);
      const tx = P.trait.x + Math.round((P.trait.w - textWidth(trait, tf)) / 2);
      z.push(`^FO${tx},${P.trait.y + Math.round((P.trait.h - tf) / 2) + 1}^A0N,${tf},${tf}^FH^FD${encodeFD(trait)}^FS`);
    }

    if (tag) {
      const payload = codePayload(tag, P);
      if (P.code.type === 'qr') {
        // ^FD prefix is <ecc><input mode>,<data>. Payload is [A-Z0-9-] only,
        // so no ^FH here — the escape underscore would corrupt the data.
        z.push(`^FO${P.code.x},${P.code.y}^BQN,2,${P.code.magnification}^FD${P.code.ecc}A,${payload}^FS`);
      } else {
        z.push(`^FO${P.code.x},${P.code.y}^BY${P.code.module}^BCN,${P.code.h},N,N,N^FD${payload}^FS`);
      }
      if (P.code.showText !== false) {
        z.push(`^FO${P.code.textX},${P.code.textY}^A0N,${P.code.textFont},${P.code.textFont}^FH^FD${encodeFD(tag)}^FS`);
      }
    }

    z.push(`^FO${P.price.x},${priceY}^A0N,${priceFont},${priceFont}^FB${P.price.field},1,0,${P.price.top != null ? 'L' : 'R'}^FH^FD${encodeFD(price)}^FS`);
    z.push('^XZ');
    return z.join('\n');
  }

  /** Concatenated labels; `copies` honours card.qty when opts.useQty is set. */
  function buildBatch(cards, opts) {
    const o = opts || {};
    const out = [];
    for (const c of cards || []) {
      const n = o.useQty ? Math.max(1, parseInt(c.qty, 10) || 1) : 1;
      for (let i = 0; i < n; i++) out.push(buildLabel(c, o));
    }
    return out.join('\n');
  }

  /** Predicted Code 128 width in dots — used to guard the layout. */
  function barcodeWidth(data, module) {
    const n = String(data || '').length;
    return (11 * (n + 2) + 13) * (module || 2);
  }

  /** QR module count for a payload at ECC M (versions 1-4 cover our ids). */
  function qrModules(data) {
    const n = String(data || '').length;
    if (n <= 14) return 21;        // v1
    if (n <= 26) return 25;        // v2
    if (n <= 42) return 29;        // v3
    if (n <= 62) return 33;        // v4
    return 37;                     // v5
  }

  /** Fields that would be clipped. Empty array means the label is safe. */
  function validate(card, opts) {
    const P = profile((opts || {}).profile);
    const problems = [];
    const name = (card.name || '').trim();
    if (!name) problems.push('missing name');
    if (P.name && fitText(name, P.name.field, P.name.tiers).truncated) problems.push('name truncated');
    if (P.setline && fitText(setLine(card), P.setline.field, [[999, P.setline.font]]).truncated) problems.push('set/number truncated');

    const price = formatPrice(tagPrice(card));
    const pf = fitFont(price, P.price.field, P.price.tiers);
    if (textWidth(price, pf) > P.price.field) problems.push('price too long');

    if (card.tagId) {
      const payload = codePayload(card.tagId, P);
      if (P.code.type === 'qr') {
        const size = qrModules(payload) * P.code.magnification;
        if (P.code.x + size > P.width - 4) problems.push('qr too wide (' + size + ' dots)');
        if (P.code.y + size > P.height - 4) problems.push('qr too tall (' + size + ' dots)');
      } else {
        const bw = barcodeWidth(payload, P.code.module);
        const limit = P.price.top != null ? P.width - 8 : P.price.x - 20;
        if (P.code.x + bw > limit) problems.push('barcode too wide (' + payload.length + ' chars)');
      }
    }
    return problems;
  }

  /* ---------- Code 128 subset B ----------
   * ^BCN (mode N) keeps the printer in subset B unless switch sequences are
   * embedded in the data, so this matches the printed symbol exactly. Other
   * encoders auto-optimise digit runs into subset C and produce a different
   * (shorter, equally valid) pattern — don't be alarmed by a mismatch there.
   */

  const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

  /** Returns an array of {x, w} bars in module units, plus total modules. */
  function code128b(data) {
    const s = String(data || '');
    let sum = 104, codes = [104];
    for (let i = 0; i < s.length; i++) {
      const v = s.charCodeAt(i) - 32;
      codes.push(v);
      sum += v * (i + 1);
    }
    codes.push(sum % 103);
    codes.push(106);
    const bars = [];
    let x = 0;
    for (const c of codes) {
      const pat = C128[c];
      for (let i = 0; i < pat.length; i++) {
        const w = parseInt(pat[i], 10);
        if (i % 2 === 0) bars.push({ x: x, w: w });
        x += w;
      }
    }
    return { bars: bars, modules: x };
  }

  /* ---------- canvas preview ---------- */

  /**
   * QR stand-in: real finder patterns, correct module count and size, but the
   * data modules are deterministic filler. The printed symbol is generated by
   * the printer's own ^BQ — this preview exists to verify LAYOUT, not content.
   */
  function drawQRStandin(g, x, y, modules, mag, s) {
    const px = v => v * s;
    g.fillStyle = '#000';
    const on = (r, c) => {
      const inFinder = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
      for (const [br, bc] of [[0, 0], [0, modules - 7], [modules - 7, 0]]) {
        if (inFinder(br, bc)) {
          const dr = r - br, dc = c - bc;
          const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          return edge || core;
        }
        if (r >= br - 1 && r < br + 8 && c >= bc - 1 && c < bc + 8) return false;
      }
      return ((r * 7 + c * 13 + ((r * c) % 5)) % 3) !== 0;
    };
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (on(r, c)) g.fillRect(px(x + c * mag), px(y + r * mag), px(mag), px(mag));
      }
    }
  }

  function drawPreview(canvas, card, scale, opts) {
    const P = profile((opts || {}).profile);
    const s = scale || 2;
    canvas.width = P.width * s;
    canvas.height = P.height * s;
    const g = canvas.getContext('2d');
    const px = v => v * s;
    const font = pt => `400 ${Math.round(pt * 0.92 * s)}px Helvetica, Arial, sans-serif`;

    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.textBaseline = 'top';

    // Diamond mark: black block with the shape knocked out white.
    const drawMark = (mx, my) => {
      const n = DIAMOND.w, u = px(1);
      g.fillStyle = '#000';
      g.fillRect(px(mx), px(my), px(n), px(n));
      g.fillStyle = '#fff';
      g.beginPath();
      const cx = px(mx + n / 2), cy = px(my + n / 2), r = px(n / 2 - 1);
      g.moveTo(cx, cy - r); g.lineTo(cx + r * 0.82, cy);
      g.lineTo(cx, cy + r);  g.lineTo(cx - r * 0.82, cy);
      g.closePath(); g.fill();
    };

    g.fillStyle = '#000';
    if (P.brand === 'text') {
      const d = DIAMOND_SOLID, gap = 6;
      const textW = textWidth(BRAND, P.header.font);
      const blockW = textW + (P.header.solidMark ? d.w + gap : 0);
      const x0 = P.header.centered ? Math.max(2, Math.round((P.width - blockW) / 2)) : (P.header.x || 6);
      if (P.header.solidMark) {
        const my = P.header.y + Math.round((P.header.font - d.h) / 2);
        const cx = px(x0 + d.w / 2), cy = px(my + d.h / 2), r = px(d.w / 2 - 1);
        g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r * 0.8, cy);
        g.lineTo(cx, cy + r); g.lineTo(cx - r * 0.8, cy); g.closePath(); g.fill();
      }
      g.font = font(P.header.font);
      g.fillText(BRAND, px(x0 + (P.header.solidMark ? d.w + gap : 0)), px(P.header.y));
    } else if (P.brand === 'spine') {
      g.fillRect(0, 0, px(P.header.w), canvas.height);
      drawMark(P.header.mark.x, P.header.mark.y);
    } else {
      g.fillRect(0, px(P.header.y || 0), canvas.width, px(P.header.h));
      if (P.header.mark) drawMark(P.header.mark.x, P.header.mark.y);
      g.fillStyle = '#fff';
      g.font = font(P.header.font);
      g.fillText(BRAND, px(P.header.textX), px(P.header.textY + 1));
    }

    if (P.name) {
      const nameFit = fitText((card.name || '').trim(), P.name.field, P.name.tiers);
      const nameY = P.name.y + Math.round((P.name.tiers[0][1] - nameFit.font) * 0.45);
      g.fillStyle = '#000';
      g.font = font(nameFit.font);
      g.fillText(nameFit.text, px(P.name.x), px(nameY));
    }
    if (P.setline) {
      const setFit = fitText(setLine(card), P.setline.field, [[999, P.setline.font]]);
      g.fillStyle = '#000';
      g.font = font(setFit.font);
      g.fillText(setFit.text, px(P.setline.x), px(P.setline.y));
    }
    g.fillStyle = '#000';

    // A sealed promo is the same card in a different product. When a variant is
    // set it takes the badge, because "SEALED" is what changes the price —
    // the condition underneath is unremarkable by comparison.
    const cond = badgeText(card);
    if (cond) {
      g.fillRect(px(P.cond.x), px(P.cond.y), px(P.cond.w), px(P.cond.h));
      g.fillStyle = '#fff';
      g.font = font(P.cond.font);
      const cw = g.measureText(cond).width;
      g.fillText(cond, px(P.cond.x) + (px(P.cond.w) - cw) / 2,
                 px(P.cond.y + Math.round((P.cond.h - P.cond.font) / 2)));
      g.fillStyle = '#000';
    }

    const trait = traitText(card);
    if (trait && P.trait) {
      let tf = P.trait.font;
      while (tf > 7 && textWidth(trait, tf) > P.trait.w - 8) tf -= 1;
      g.strokeStyle = '#000'; g.lineWidth = Math.max(1, px(2));
      g.strokeRect(px(P.trait.x) + px(1), px(P.trait.y) + px(1), px(P.trait.w) - px(2), px(P.trait.h) - px(2));
      g.fillStyle = '#000';
      g.font = font(tf);
      const tw = g.measureText(trait).width;
      g.fillText(trait, px(P.trait.x) + (px(P.trait.w) - tw) / 2, px(P.trait.y + Math.round((P.trait.h - tf) / 2)));
    }

    if (card.tagId) {
      const payload = codePayload(card.tagId, P);
      if (P.code.type === 'qr') {
        drawQRStandin(g, P.code.x, P.code.y, qrModules(payload), P.code.magnification, s);
      } else {
        const bc = code128b(payload), m = P.code.module;
        for (const b of bc.bars) {
          g.fillRect(px(P.code.x + b.x * m), px(P.code.y), px(b.w * m), px(P.code.h));
        }
      }
      if (P.code.showText !== false) {
        g.fillStyle = '#000';
        g.font = font(P.code.textFont);
        g.fillText(card.tagId, px(P.code.textX), px(P.code.textY));
      }
    }

    const price = formatPrice(tagPrice(card));
    const priceFont = fitFont(price, P.price.field, P.price.tiers);
    const priceY = P.price.top != null ? P.price.top : (P.height - P.price.bottom - priceFont);
    g.font = font(priceFont);
    const pw = g.measureText(price).width;
    const pxPos = P.price.top != null ? px(P.price.x) : px(P.price.x + P.price.field) - pw;
    g.fillText(price, pxPos, px(priceY));

    g.strokeStyle = '#ccc';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  }

  /* ---------- Zebra Browser Print ---------- */

  const BP_HOSTS = ['http://localhost:9100', 'https://localhost:9101'];
  let bpBase = null, bpDevice = null;

  async function bpFind() {
    if (bpBase) return bpBase;
    for (const host of BP_HOSTS) {
      try {
        const r = await fetch(host + '/available', { method: 'GET' });
        if (r.ok) { bpBase = host; return host; }
      } catch (e) { /* try the next one */ }
    }
    throw new Error('Zebra Browser Print not reachable. Is the service running?');
  }

  async function bpDefault(force) {
    if (bpDevice && !force) return bpDevice;
    const base = await bpFind();
    const r = await fetch(base + '/default?type=printer');
    if (!r.ok) throw new Error('No default printer set in Browser Print.');
    const txt = (await r.text()).trim();
    bpDevice = txt.startsWith('{') ? JSON.parse(txt) : null;
    if (!bpDevice) {
      const list = await (await fetch(base + '/available')).json();
      bpDevice = (list.printer && list.printer[0]) || (list.device && list.device[0]);
    }
    if (!bpDevice) throw new Error('No Zebra printer found.');
    return bpDevice;
  }

  async function bpStatus() {
    try {
      const dev = await bpDefault();
      return { ok: true, name: dev.name || dev.uid || 'Zebra printer', base: bpBase };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Every device Browser Print knows about, printers first. */
  async function bpDevices() {
    const base = await bpFind();
    const r = await fetch(base + '/available');
    if (!r.ok) return [];
    const j = await r.json();
    return [].concat(j.printer || [], j.device || []);
  }

  async function bpWriteTo(base, device, zpl, contentType) {
    const r = await fetch(base + '/write', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify({ device: device, data: zpl })
    });
    const body = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, body: (body || '').trim() };
  }

  /**
   * Browser Print answers 500 for a whole family of problems — unapproved
   * origin, a device object it doesn't recognise, a printer that is offline.
   * It never says which, so try the plausible combinations and report every
   * failure verbatim instead of swallowing them.
   */
  async function printZPL(zpl) {
    const base = await bpFind();
    const tried = [];
    const devices = [];
    try { devices.push(await bpDefault()); } catch (e) { tried.push('default device: ' + e.message); }
    for (const d of await bpDevices()) {
      if (!devices.some(x => x && x.uid === d.uid)) devices.push(d);
    }
    if (!devices.length) throw new Error('Browser Print reports no devices.');

    for (const ct of ['text/plain;charset=UTF-8', 'application/json']) {
      for (const d of devices) {
        const res = await bpWriteTo(base, d, zpl, ct);
        if (res.ok) return true;
        tried.push(`${d && (d.name || d.uid) || '?'} [${ct.split(';')[0]}] -> ${res.status}${res.body ? ': ' + res.body.slice(0, 160) : ''}`);
      }
    }
    const err = new Error('Browser Print rejected the job.\n\n' + tried.join('\n'));
    err.attempts = tried;
    throw err;
  }

  /** Raw dump of everything Browser Print exposes, for troubleshooting. */
  async function diagnose(zpl) {
    const out = { origin: (typeof location !== 'undefined' ? location.origin + ' (' + location.protocol + ')' : 'n/a') };
    try { out.base = await bpFind(); } catch (e) { out.base = 'unreachable: ' + e.message; return out; }
    try {
      const r = await fetch(out.base + '/available');
      out.available = await r.json();
    } catch (e) { out.available = 'error: ' + e.message; }
    try {
      const r = await fetch(out.base + '/default?type=printer');
      out.defaultRaw = (await r.text()).slice(0, 400);
      out.defaultStatus = r.status;
    } catch (e) { out.defaultRaw = 'error: ' + e.message; }
    if (zpl) {
      out.writeAttempts = [];
      const devices = [].concat((out.available && out.available.printer) || [],
                               (out.available && out.available.device) || []);
      for (const d of devices) {
        for (const ct of ['text/plain;charset=UTF-8', 'application/json']) {
          try {
            const res = await bpWriteTo(out.base, d, zpl, ct);
            out.writeAttempts.push({ device: d.name || d.uid, connection: d.connection, contentType: ct, status: res.status, body: res.body.slice(0, 200) });
          } catch (e) {
            out.writeAttempts.push({ device: d.name || d.uid, contentType: ct, error: e.message });
          }
        }
      }
    }
    return out;
  }

  /**
   * Media calibration. Small stock is the case where the printer most needs to
   * be told where one label ends and the next begins — without it the top of
   * the design lands on the gap.
   */
  const CALIBRATE_ZPL = '~JC\n^XA^JUS^XZ';

  /** A ruled box the exact size of the label, for checking alignment. */
  function alignmentZPL(profileKey) {
    const P = profile(profileKey);
    return ['^XA', '^CI28', '^PW' + P.width, '^LL' + P.height, '^LH0,0', '^PR2', '^MD' + P.darkness,
      `^FO0,0^GB${P.width - 1},${P.height - 1},2^FS`,
      `^FO4,4^GB18,18,18^FS`,
      `^FO${P.width - 22},4^GB18,18,18^FS`,
      `^FO4,${P.height - 22}^GB18,18,18^FS`,
      `^FO${P.width - 22},${P.height - 22}^GB18,18,18^FS`,
      `^FO${Math.round(P.width / 2) - 30},${Math.round(P.height / 2) - 10}^A0N,20,20^FD${P.width}x${P.height}^FS`,
      '^XZ'].join('\n');
  }

  /** Fallback when Browser Print isn't installed: save a .zpl to send manually. */
  function downloadZPL(zpl, filename) {
    const blob = new Blob([zpl], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'paragon-labels.zpl';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const API = {
    PROFILES, BRAND, DIAMOND, DIAMOND_SOLID, profile,
    LAYOUT: PROFILES.std,
    fitFont, fitText, textWidth, encodeFD, formatPrice, setLine, tagPrice,
    formatTagId, highestTagNumber, assignTagIds,
    badgeText, traitText, buildLabel, buildBatch, validate, barcodeWidth, qrModules, codePayload, code128b,
    drawPreview, bpStatus, bpDevices, printZPL, diagnose, downloadZPL,
    CALIBRATE_ZPL, alignmentZPL
  };

  if (typeof window !== 'undefined') window.Labels = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
