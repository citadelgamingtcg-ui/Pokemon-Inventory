// Netlify function — card search with TCGPlayer prices
// Primary: tcgapi.dev (fast). Fallback: TCGCSV (unlimited, fixes edge cases).
// Endpoint: /.netlify/functions/search?q=Riolu&number=215

const TCGAPI_KEY = process.env.TCGAPI_KEY;
const TCGCSV = 'https://tcgcsv.com';
const UA = 'PokeInventory/2.5.0';

// Cache groups per category (3 = English Pokémon, 85 = Japanese Pokémon)
const groupsCache = {}, groupsCacheTime = {};
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function getGroups(cat = 3) {
  if (groupsCache[cat] && (Date.now() - (groupsCacheTime[cat] || 0)) < CACHE_TTL) return groupsCache[cat];
  const res = await fetch(`${TCGCSV}/tcgplayer/${cat}/groups`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Groups ${res.status}`);
  groupsCache[cat] = (await res.json()).results || [];
  groupsCacheTime[cat] = Date.now();
  return groupsCache[cat];
}

async function searchTcgcsv(nameLower, number, deadline, cat = 3) {
  const groups = await getGroups(cat);
  // Japanese catalog is larger and less date-ordered — scan more sets for JP.
  const scanCount = cat === 85 ? 60 : 30;
  const searchGroups = [...groups].reverse().slice(0, scanCount);
  const matches = [];

  for (let i = 0; i < searchGroups.length && matches.length < 30; i += 10) {
    // Stop if we're approaching the Netlify timeout
    if (Date.now() > deadline) break;
    const batch = searchGroups.slice(i, i + 10);
    const batchData = await Promise.all(batch.map(async group => {
      try {
        const [pRes, prRes] = await Promise.all([
          fetch(`${TCGCSV}/tcgplayer/${cat}/${group.groupId}/products`, { headers: { 'User-Agent': UA } }),
          fetch(`${TCGCSV}/tcgplayer/${cat}/${group.groupId}/prices`, { headers: { 'User-Agent': UA } })
        ]);
        if (!pRes.ok || !prRes.ok) return [];
        const products = (await pRes.json()).results || [];
        const prices   = (await prRes.json()).results || [];
        const priceMap = {};
        prices.forEach(pr => { (priceMap[pr.productId] ||= []).push(pr); });

        return products.filter(p => {
          const pName = (p.name || '').toLowerCase().replace(/\s*-\s*\d+\/\d+.*$/, '').trim();
          return pName === nameLower || pName.startsWith(nameLower) ||
                 (nameLower.length > 4 && pName.includes(nameLower));
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
            printing: best?.subTypeName ?? null
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
    matches.sort((a, b) => (b.market_price || 0) - (a.market_price || 0));
  }
  return matches;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const jp = event.queryStringParameters?.jp === '1';
  const cat = jp ? 85 : 3;
  // The frontend appends "Japanese" to JP queries for the old English path.
  // Category 85 is already all-Japanese, so strip that word out of the search term.
  const q = (event.queryStringParameters?.q || '').trim().replace(/\s*\bjapanese\b\s*/ig, ' ').trim();
  const number = (event.queryStringParameters?.number || '').split('/')[0].replace(/^0+/, '');
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing q' }) };

  // 1) Try tcgapi.dev first (fast). Strip apostrophes — they break the query.
  let tcgapiNote = '';
  if (TCGAPI_KEY) {
    try {
      const cleanQ = q.replace(/['']/g, '');
      const langParam = jp ? '&language=japanese' : '';
      const url = `https://api.tcgapi.dev/v1/search?q=${encodeURIComponent(cleanQ)}&game=pokemon${langParam}&per_page=100&sort=price_desc`;
      const res = await fetch(url, { headers: { 'X-API-Key': TCGAPI_KEY } });
      tcgapiNote = `tcgapi.dev:${res.status}`;
      if (res.ok) {
        const data = await res.json();
        if ((data.data || []).length > 0) {
          data._note = tcgapiNote;
          return { statusCode: 200, headers, body: JSON.stringify(data) };
        }
        tcgapiNote += ':empty';
      } else {
        // 429 = rate limited (out of daily requests)
        tcgapiNote += res.status === 429 ? ':RATE_LIMITED' : '';
      }
    } catch (e) { tcgapiNote = `tcgapi.dev:error:${e.message}`; }
  } else {
    tcgapiNote = 'no-key';
  }

  // 2) Fallback: TCGCSV (unlimited, different data source — catches edge cases)
  try {
    const deadline = Date.now() + 8000; // 8s budget, leaves margin under 10s limit
    const nameLower = q.toLowerCase().replace(/['']/g, '').replace(/\bex\b/gi, 'ex').trim();
    const matches = await searchTcgcsv(nameLower, number, deadline, cat);
    return { statusCode: 200, headers, body: JSON.stringify({ data: matches, source: 'tcgcsv', cat, note: tcgapiNote }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ data: [], error: err.message }) };
  }
};
