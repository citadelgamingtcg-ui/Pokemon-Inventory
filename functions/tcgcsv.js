// Cloudflare Pages Function — proxies TCGCSV
// Endpoint: /tcgcsv?path=/tcgplayer/3/groups
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
  if (!path || !path.startsWith('/tcgplayer/')) {
    return new Response(JSON.stringify({ error: 'Invalid path' }), { status: 400, headers });
  }
  try {
    const res = await fetch(`https://tcgcsv.com${path}`, { headers: { 'User-Agent': 'PokeInventory/3.0' } });
    const data = await res.text();
    return new Response(data, { status: res.status, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
