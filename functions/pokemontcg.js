// Cloudflare Pages Function — proxies pokemontcg.io
// Endpoint: /pokemontcg?path=/v2/cards&q=...
//
// Second source for card images. TCGCSV mirrors TCGplayer's own catalog, so
// it lags behind by however long TCGplayer itself takes to list a new card.
// pokemontcg.io is built independently — it sometimes has a card before
// TCGCSV does, sometimes after. Checking both is strictly better than
// checking one, at no cost, since this is a free public API.
export async function onRequest(context) {
  const { request } = context;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600'
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers });

  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (!path || !path.startsWith('/v2/')) {
    return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers });
  }
  // Forward every other query param straight through (q, page, pageSize, ...)
  const qs = new URLSearchParams(url.search);
  qs.delete('path');
  const target = `https://api.pokemontcg.io${path}${qs.toString() ? '?' + qs.toString() : ''}`;

  try {
    const res = await fetch(target, { headers: { 'User-Agent': 'PokeInventory/3.0' } });
    const data = await res.text();
    return new Response(data, { status: res.status, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
