// Cloudflare Pages Function — card search with TCGPlayer prices
// Endpoint: /search?q=Riolu&number=215  (Cloudflare maps /functions/search.js → /search)

const TCGCSV = 'https://tcgcsv.com';
const UA = 'PokeInventory/3.0';

const EN_CATEGORY = 3;        // English Pokémon
let JP_CATEGORY = null;       // Japanese Pokémon — discovered at runtime

const groupsCacheByCat = {};  // { [categoryId]: { groups, time } }
const CACHE_TTL = 6 * 60 * 60 * 1000;

// Find the Japanese Pokémon category id by scanning the categories list
async function getJapaneseCategory() {
  if (JP_CATEGORY) return JP_CATEGORY;
  try {
    const res = await fetch(`${TCGCSV}/tcgplayer/categories`, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const cats = (await res.json()).results || [];
      const jp = cats.find(c => /japan/i.test(c.name) && /pok[eé]mon/i.test(c.name));
      if (jp) { JP_CATEGORY = jp.categoryId; return JP_CATEGORY; }
    }
  } catch {}
  JP_CATEGORY = 85; // common fallback for Pokémon Japan
  return JP_CATEGORY;
}

async function getGroups(categoryId = EN_CATEGORY) {
  const cached = groupsCacheByCat[categoryId];
  if (cached && (Date.now() - cached.time) < CACHE_TTL) return cached.groups;
  const res = await fetch(`${TCGCSV}/tcgplayer/${categoryId}/groups`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Groups ${res.status}`);
  const groups = (await res.json()).results || [];
  groupsCacheByCat[categoryId] = { groups, time: Date.now() };
  return groups;
}

async function searchTcgcsv(nameLower, number, deadline, categoryId = EN_CATEGORY, setHint = '') {
  const groups = await getGroups(categoryId);
  // If we have a set hint, prioritize groups whose name matches it
  let ordered = [...groups].reverse();
  if (setHint) {
    const hint = setHint.toLowerCase();
    const tokens = hint.match(/[a-z0-9]+/g) || [];
    ordered.sort((a, b) => {
      const an = (a.name||'').toLowerCase(), bn = (b.name||'').toLowerCase();
      // Strong boost for direct substring match (e.g. "chaos rising" in the group name)
      const aDirect = an.includes(hint) ? 100 : 0;
      const bDirect = bn.includes(hint) ? 100 : 0;
      const aScore = aDirect + tokens.reduce((s,t) => s + (an.includes(t) ? 1 : 0), 0);
      const bScore = bDirect + tokens.reduce((s,t) => s + (bn.includes(t) ? 1 : 0), 0);
      return bScore - aScore;
    });
  }
  const searchGroups = ordered.slice(0, setHint ? 15 : 25);
  // Map groupId → recency rank (0 = most recent, since `ordered` is newest-first)
  const recencyRank = {};
  ordered.forEach((g, idx) => { recencyRank[g.groupId] = idx; });
  const matches = [];
  for (let i = 0; i < searchGroups.length && matches.length < 50; i += 5) {
    if (Date.now() > deadline) break;
    const batch = searchGroups.slice(i, i + 10);
    const batchData = await Promise.all(batch.map(async group => {
      try {
        const [pRes, prRes] = await Promise.all([
          fetch(`${TCGCSV}/tcgplayer/${categoryId}/${group.groupId}/products`, { headers: { 'User-Agent': UA } }),
          fetch(`${TCGCSV}/tcgplayer/${categoryId}/${group.groupId}/prices`, { headers: { 'User-Agent': UA } })
        ]);
        if (!pRes.ok || !prRes.ok) return [];
        const products = (await pRes.json()).results || [];
        const prices   = (await prRes.json()).results || [];
        const priceMap = {};
        prices.forEach(pr => { (priceMap[pr.productId] ||= []).push(pr); });
        return products.filter(p => {
          const pName = (p.name || '').toLowerCase()
            .replace(/\s*-\s*\d+\/\d+.*$/, '')
            .replace(/['']/g, '')   // strip apostrophes so "Rocket's" matches "Rockets"
            .replace(/-/g, ' ')     // strip hyphens so "Ho-Oh" matches "Ho Oh"
            .trim();
          const target = nameLower.replace(/['']/g, '').replace(/-/g, ' ');
          return pName === target || pName.startsWith(target) ||
                 (target.length > 4 && pName.includes(target));
        }).map(p => {
          const ext = p.extendedData || [];
          const pp = priceMap[p.productId] || [];
          const pref = ['Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition Holofoil'];
          let best = null;
          for (const s of pref) { best = pp.find(x => x.subTypeName === s); if (best) break; }
          if (!best && pp.length) best = pp[0];
          return {
            name: (p.name || '').replace(/\s*-\s*\d+\/\d+.*$/, '').trim(),
            set_name: group.name,
            number: ext.find(d => d.name === 'Number')?.value || '',
            rarity: ext.find(d => d.name === 'Rarity')?.value || '',
            image_url: p.imageUrl || null,
            tcgplayer_id: p.productId,
            market_price: best?.marketPrice ?? null,
            low_price: best?.lowPrice ?? null,
            printing: best?.subTypeName ?? null,
            _recency: recencyRank[group.groupId] ?? 999
          };
        });
      } catch { return []; }
    }));
    batchData.flat().forEach(m => matches.push(m));
  }
  if (number) {
    matches.sort((a, b) => {
      const an = (a.number || '').split('/')[0].replace(/^0+/, '') === number ? 0 : 1;
      const bn = (b.number || '').split('/')[0].replace(/^0+/, '') === number ? 0 : 1;
      if (an !== bn) return an - bn;
      return (b.market_price || 0) - (a.market_price || 0);
    });
  } else {
    // No number given: show most recent printings first, then by price within same recency
    matches.sort((a, b) => {
      if (a._recency !== b._recency) return a._recency - b._recency;
      return (b.market_price || 0) - (a.market_price || 0);
    });
  }
  return matches;
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers });

  try {

  const url = new URL(request.url);
  let q = (url.searchParams.get('q') || '').trim();
  const number = (url.searchParams.get('number') || '').split('/')[0].replace(/^0+/, '');
  const setHint = (url.searchParams.get('set') || '').trim();
  const isSealed = url.searchParams.get('sealed') === '1';
  if (!q) return new Response(JSON.stringify({ error: 'Missing q' }), { status: 400, headers });

  // Detect Japanese request (the frontend appends "Japanese")
  const isJapanese = /japanese/i.test(q);
  const cleanName = q.replace(/japanese/ig, '').trim();

  const TCGAPI_KEY = env.TCGAPI_KEY;
  let tcgapiNote = '';

  // 1) tcgapi.dev first (English cards — its JP coverage is poor, so skip it for JP)
  if (TCGAPI_KEY && !isJapanese) {
    try {
      const cleanQ = q.replace(/['']/g, '');
      // For sealed products, filter by product_type
      const sealedParam = isSealed ? '&product_type=Sealed+Products' : '';
      const apiUrl = `https://api.tcgapi.dev/v1/search?q=${encodeURIComponent(cleanQ)}&game=pokemon&per_page=100&sort=price_desc${sealedParam}`;
      const res = await fetch(apiUrl, { headers: { 'X-API-Key': TCGAPI_KEY } });
      tcgapiNote = `tcgapi.dev:${res.status}`;
      if (res.ok) {
        const data = await res.json();
        const list = data.data || [];
        if (list.length > 0) {
          // If a number was requested, make sure tcgapi actually has it.
          // If not (e.g. brand-new set tcgapi hasn't indexed), fall through to TCGCSV.
          if (number) {
            const hasNumber = list.some(c => (c.number||'').split('/')[0].replace(/^0+/,'') === number);
            if (!hasNumber) {
              tcgapiNote += ':number-not-found-trying-tcgcsv';
              // fall through to TCGCSV below
            } else {
              data._note = tcgapiNote;
              return new Response(JSON.stringify(data), { status: 200, headers });
            }
          } else {
            data._note = tcgapiNote;
            return new Response(JSON.stringify(data), { status: 200, headers });
          }
        } else {
          tcgapiNote += ':empty';
        }
      } else if (res.status === 429) {
        tcgapiNote += ':RATE_LIMITED';
      }
    } catch (e) { tcgapiNote = `tcgapi.dev:error:${e.message}`; }
  } else if (isJapanese) {
    tcgapiNote = 'jp-routed-to-tcgcsv';
  } else {
    tcgapiNote = 'no-key';
  }

  // 2) TCGCSV fallback — use Japanese category for JP cards
  try {
    const deadline = Date.now() + 6000;
    const nameLower = cleanName.toLowerCase().replace(/['']/g, '').replace(/\bex\b/gi, 'ex').trim();
    const categoryId = isJapanese ? await getJapaneseCategory() : EN_CATEGORY;
    const matches = await searchTcgcsv(nameLower, number, deadline, categoryId, setHint);
    return new Response(JSON.stringify({
      data: matches,
      source: isJapanese ? `tcgcsv-jp(cat${categoryId})` : 'tcgcsv',
      note: tcgapiNote
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ data: [], error: err.message }), { status: 200, headers });
  }
  } catch(outerErr) {
    return new Response(JSON.stringify({ data: [], error: 'Function error: ' + outerErr.message }), { status: 200, headers });
  }
}
