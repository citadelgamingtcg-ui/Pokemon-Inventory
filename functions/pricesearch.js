// Dedicated search for the PRICE TOOL — returns MANY results for browsing.
// Endpoint: /pricesearch?q=charmander[&jp=1]
// Uses tcgapi.dev (100 results, price-sorted) with a tcgcsv JP fallback.

const TCGCSV = 'https://tcgcsv.com';
const UA = 'ParagonPrice/1.0';
let JP_CATEGORY = null;

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
  JP_CATEGORY = 85; return JP_CATEGORY;
}

const gcache = {};
async function getGroups(cat) {
  if (gcache[cat] && Date.now() - gcache[cat].t < 6*3600*1000) return gcache[cat].g;
  const res = await fetch(`${TCGCSV}/tcgplayer/${cat}/groups`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('groups ' + res.status);
  const g = (await res.json()).results || [];
  gcache[cat] = { g, t: Date.now() };
  return g;
}

async function tcgcsvSearch(nameLower, cat, deadline) {
  const groups = await getGroups(cat);
  const ordered = [...groups].reverse();
  const recency = {}; ordered.forEach((g,i) => recency[g.groupId] = i);
  const searchGroups = ordered; // scan ALL sets for full coverage
  const matches = [];
  const BATCH = 25; // wider parallel batches to cover many JP sets before deadline
  for (let i = 0; i < searchGroups.length; i += BATCH) {
    if (Date.now() > deadline) break;
    const batch = searchGroups.slice(i, i + BATCH);
    const bd = await Promise.all(batch.map(async group => {
      try {
        const [pRes, prRes] = await Promise.all([
          fetch(`${TCGCSV}/tcgplayer/${cat}/${group.groupId}/products`, { headers: { 'User-Agent': UA } }),
          fetch(`${TCGCSV}/tcgplayer/${cat}/${group.groupId}/prices`, { headers: { 'User-Agent': UA } })
        ]);
        if (!pRes.ok || !prRes.ok) return [];
        const products = (await pRes.json()).results || [];
        const prices = (await prRes.json()).results || [];
        const pm = {}; prices.forEach(pr => (pm[pr.productId] ||= []).push(pr));
        return products.filter(p => {
          const pn = (p.name||'').toLowerCase().replace(/\s*-\s*\d+\/\d+.*$/,'').replace(/[''']/g,'').replace(/-/g,' ').trim();
          const t = nameLower.replace(/[''']/g,'').replace(/-/g,' ');
          return pn === t || pn.startsWith(t) || (t.length > 3 && pn.includes(t));
        }).map(p => {
          const ext = p.extendedData || [];
          const pp = pm[p.productId] || [];
          let best = null;
          for (const s of ['Holofoil','Normal','Reverse Holofoil','1st Edition Holofoil']) { best = pp.find(x=>x.subTypeName===s); if(best) break; }
          if (!best && pp.length) best = pp[0];
          return {
            name: (p.name||'').replace(/\s*-\s*\d+\/\d+.*$/,'').trim(),
            set_name: group.name,
            number: ext.find(d=>d.name==='Number')?.value || '',
            image_url: p.imageUrl || null,
            tcgplayer_id: p.productId,
            market_price: best?.marketPrice ?? best?.midPrice ?? null,
            _recency: recency[group.groupId] ?? 999
          };
        });
      } catch { return []; }
    }));
    bd.flat().forEach(m => matches.push(m));
  }
  matches.sort((a,b) => a._recency !== b._recency ? a._recency - b._recency : (b.market_price||0)-(a.market_price||0));
  return matches;
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers });
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q')||'').trim();
    const isJP = url.searchParams.get('jp') === '1';
    if (!q) return new Response(JSON.stringify({ data: [] }), { headers });
    const nameLower = q.toLowerCase().replace(/[''']/g,'').trim();

    // English: tcgapi.dev — return raw data through, exactly like the inventory app
    const KEY = env.TCGAPI_KEY;
    if (KEY && !isJP) {
      try {
        const cleanQ = q.replace(/['']/g, '');
        const r = await fetch(`https://api.tcgapi.dev/v1/search?q=${encodeURIComponent(cleanQ)}&game=pokemon&per_page=100&sort=price_desc`, { headers: { 'X-API-Key': KEY } });
        if (r.ok) {
          const d = await r.json();
          if ((d.data||[]).length) { d.source = 'tcgapi'; return new Response(JSON.stringify(d), { status: 200, headers }); }
        }
      } catch(e){}
    }

    // JP (and English fallback): tcgcsv scan
    const cat = isJP ? await getJapaneseCategory() : 3;
    const matches = await tcgcsvSearch(nameLower, cat, Date.now() + (isJP ? 20000 : 10000));
    return new Response(JSON.stringify({ data: matches, source: `tcgcsv-${cat}` }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ data: [], error: e.message }), { headers });
  }
}
