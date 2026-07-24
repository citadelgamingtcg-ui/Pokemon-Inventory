// api.js — TCGTracking.com live price lookups
// Free, no API key needed, CORS enabled
// Pokémon EN = category 3, Pokémon JP = category 85

const TCG_BASE = 'https://tcgtracking.com/tcgapi/v1';

// Session cache
const _setCache = {};
const _priceCache = {};
const _productCache = {};

async function searchSets(query, catId = 3) {
  const res = await fetch(`${TCG_BASE}/${catId}/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.sets || [];
}

async function getSetProducts(setId, catId = 3) {
  const key = `${catId}_${setId}`;
  if (_setCache[key]) return _setCache[key];
  const res = await fetch(`${TCG_BASE}/${catId}/sets/${setId}`);
  if (!res.ok) return [];
  const data = await res.json();
  _setCache[key] = data.products || [];
  return _setCache[key];
}

async function getSetPricing(setId, catId = 3) {
  const key = `${catId}_${setId}`;
  if (_priceCache[key]) return _priceCache[key];
  const res = await fetch(`${TCG_BASE}/${catId}/sets/${setId}/pricing`);
  if (!res.ok) return {};
  const data = await res.json();
  _priceCache[key] = data.prices || {};
  return _priceCache[key];
}

function extractPrice(priceData) {
  if (!priceData?.tcg) return null;
  const subtypes = Object.keys(priceData.tcg);
  // Pick best subtype — don't default to Normal for SIR/holo cards
  const preferred = ['Holofoil', 'Normal', 'Reverse Holofoil', 'Foil', '1st Edition Holofoil'];
  let chosen = subtypes[0];
  for (const pref of preferred) {
    if (subtypes.includes(pref)) { chosen = pref; break; }
  }
  const market = priceData.tcg[chosen]?.market;
  return market != null ? { price: parseFloat(market), subtype: chosen } : null;
}

/**
 * Look up market price by card name + set + number.
 * NUMBER is used as primary match when available — critical for SIR vs common same name.
 */
async function lookupCardPrice(cardName, setName = '', cardNumber = '', catId = 3) {
  try {
    const cardNameLower  = (cardName||'').toLowerCase().trim();
    const numClean       = cardNumber ? cardNumber.split('/')[0].replace(/^0+/, '') : '';

    // ── SET NAME MAPPING ──────────────────────────────────────────────────
    // Map scan API set names → TCGTracking search terms
    const SET_MAP = [
      // Scarlet & Violet era
      [/sv01|sv1|scarlet.violet.base|\bsvi\b/i,   'Scarlet & Violet'],
      [/sv02|sv2|\bpal\b|paldea evolved/i,          'Paldea Evolved'],
      [/sv03|sv3|\bobs\b|obsidian flames/i,         'Obsidian Flames'],
      [/sv04|sv4|\bpar\b|paradox rift/i,            'Paradox Rift'],
      [/sv05|sv5|\btem\b|temporal forces/i,         'Temporal Forces'],
      [/sv06|sv6|\btwm\b|twilight masquerade/i,     'Twilight Masquerade'],
      [/sv07|sv7|stellar crown/i,                     'Stellar Crown'],
      [/sv08|sv8|surging sparks/i,                    'Surging Sparks'],
      [/sv09|sv9|journey together/i,                  'Journey Together'],
      [/\bpaf\b|paldean fates/i,                    'Paldean Fates'],
      [/shrouded fable/i,                             'Shrouded Fable'],
      [/prismatic evolutions/i,                       'Prismatic Evolutions'],
      // Sword & Shield era
      [/swsh01|sword.shield.base|\bssh\b/i,         'Sword & Shield'],
      [/swsh02|rebel clash/i,                         'Rebel Clash'],
      [/swsh03|darkness ablaze/i,                     'Darkness Ablaze'],
      [/swsh04|vivid voltage/i,                       'Vivid Voltage'],
      [/swsh05|battle styles/i,                       'Battle Styles'],
      [/swsh06|chilling reign/i,                      'Chilling Reign'],
      [/swsh07|evolving skies/i,                      'Evolving Skies'],
      [/swsh08|fusion strike/i,                       'Fusion Strike'],
      [/swsh09|brilliant stars/i,                     'Brilliant Stars'],
      [/swsh10|astral radiance/i,                     'Astral Radiance'],
      [/swsh11|lost origin/i,                         'Lost Origin'],
      [/swsh12|silver tempest/i,                      'Silver Tempest'],
      [/swsh12pt5|crown zenith/i,                     'Crown Zenith'],
      [/trainer gallery/i,                            'Trainer Gallery'],
      [/\bcri\b|crimson invasion/i,                 'Crimson Invasion'],
      [/\bpre\b|pokemon go/i,                       'Pokemon GO'],
      [/me01|mega evolution/i,                         'Mega Evolution'],
      [/me02|phantasmal flames/i,                      'Phantasmal Flames'],
      [/me03|perfect order/i,                          'Perfect Order'],
      [/me04|chaos rising/i,                           'Chaos Rising'],
      [/miscellaneous/i,                               ''],
    ];

    // Build search queries
    const queries = new Set();
    if (setName) {
      let mapped = false;
      for (const [pattern, replacement] of SET_MAP) {
        if (pattern.test(setName)) {
          queries.add(replacement);
          mapped = true;
          break;
        }
      }
      if (!mapped) queries.add(setName);
    }
    // Always add card name as fallback
    queries.add(cardNameLower.split(' ')[0]);

    // ── SEARCH SETS ───────────────────────────────────────────────────────
    for (const q of queries) {
      const sets = await searchSets(q, catId);
      if (!sets.length) continue;

      // Deduplicate set IDs
      const seenIds = new Set();
      const uniqueSets = sets.filter(s => { if(seenIds.has(s.id)) return false; seenIds.add(s.id); return true; });

      for (const set of uniqueSets.slice(0, 8)) {
        const [products, pricing] = await Promise.all([
          getSetProducts(set.id, catId),
          getSetPricing(set.id, catId)
        ]);

        let best = null;

        // Priority 1: exact number match (most precise)
        if (numClean) {
          best = products.find(p => {
            const pNum = (p.number||'').split('/')[0].replace(/^0+/, '');
            return pNum === numClean;
          });
        }

        // Priority 2: exact name match
        if (!best) {
          best = products.find(p =>
            (p.clean_name||p.name||'').toLowerCase() === cardNameLower
          );
        }

        // Priority 3: starts-with name match
        if (!best) {
          best = products.find(p =>
            (p.clean_name||p.name||'').toLowerCase().startsWith(cardNameLower)
          );
        }

        if (best) {
          const priceData = pricing[best.id] || pricing[String(best.id)];
          const extracted = extractPrice(priceData);
          if (extracted) {
            return {
              price:     extracted.price,
              subtype:   extracted.subtype,
              setName:   set.name,
              productId: best.id,
              tcgUrl:    best.tcgplayer_url || null,
              imageUrl:  cleanImageUrl(best.image_url)
            };
          }
        }
      }
    }
    // Fallback: Pokemon TCG API (pokemontcg.io) — proper name search
    try {
      const searchName = cardName.replace(/\bEx\b/g, 'ex').trim();
      const url = `https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(searchName)}"&pageSize=20&orderBy=-set.releaseDate`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const cards = data.data || [];
        for (const card of cards) {
          // Match by number if we have one
          const matches = cardNumber
            ? (card.number === cardNumber || card.number === cardNumber.split('/')[0])
            : true;
          if (!matches) continue;
          const tcg = card.tcgplayer?.prices;
          if (!tcg) continue;
          const variants = ['holofoil','normal','reverseHolofoil','1stEditionHolofoil'];
          for (const v of [...variants, ...Object.keys(tcg)]) {
            if (tcg[v]?.market != null) {
              return {
                price:     parseFloat(tcg[v].market),
                subtype:   v,
                setName:   card.set?.name || '',
                productId: card.id,
                tcgUrl:    card.tcgplayer?.url || null,
                imageUrl:  card.images?.large || card.images?.small || null
              };
            }
          }
        }
      }
    } catch(e) { console.warn('Pokemon TCG API fallback failed:', e); }

    return null;
  } catch (err) {
    console.warn('TCGTracking lookup failed for', cardName, err);
    return null;
  }
}

async function batchLookupPrices(cards) {
  const CHUNK = 4;
  const results = new Array(cards.length).fill(null);
  for (let i = 0; i < cards.length; i += CHUNK) {
    const chunk = cards.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(
      chunk.map(c => lookupCardPrice(c.name, c.set, c.number))
    );
    chunkResults.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

function cleanImageUrl(url) {
  if (!url) return null;
  const bad = ['no_image','noimage','placeholder','default','coming_soon',
               '/images/default','card-back','product/image/0','_0.jpg'];
  const lower = url.toLowerCase();
  if (bad.some(b => lower.includes(b))) return null;
  if (!url.startsWith('http')) return null;
  return url;
}

async function fetchCardImage(name, set, number) {
  const RAPID_KEY = '8300bce378msh89d4b9140c417b7p13e6b7jsnfd4d0273dcf9';
  try {
    const query = number ? `${name} ${number}` : `${name} ${set||''}`.trim();
    const res = await fetch(
      `https://pokemon-tcg-api.p.rapidapi.com/cards?search=${encodeURIComponent(query)}&limit=5`,
      { headers: { 'x-rapidapi-host': 'pokemon-tcg-api.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const cards = data.data || data.cards || data.results || (Array.isArray(data) ? data : []);
    if (!cards.length) return null;

    const nameLower = name.toLowerCase().trim();
    const best = cards.find(c =>
      (c.name||'').toLowerCase() === nameLower &&
      number && (c.number === number || c.collector_number === number)
    ) || cards.find(c => (c.name||'').toLowerCase() === nameLower) || cards[0];

    const img = best?.images?.large || best?.images?.small || best?.image || best?.image_url || best?.img || null;
    return cleanImageUrl(img);
  } catch(e) {
    console.warn('fetchCardImage failed:', e);
    return null;
  }
}

window.TCGApi = { lookupCardPrice, batchLookupPrices, searchSets, cleanImageUrl, fetchCardImage };
