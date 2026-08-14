// Netlify serverless function — proxies TCGCSV (blocked by CORS from browser)
// Endpoint: /.netlify/functions/tcgcsv?path=/tcgplayer/3/groups

const TCGCSV_BASE = 'https://tcgcsv.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600' // cache 1 hour
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.queryStringParameters?.path || '';
  if (!path) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing path parameter' }) };
  }

  // Safety: only allow tcgcsv.com paths
  if (!path.startsWith('/tcgplayer/')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden path' }) };
  }

  try {
    const url = `${TCGCSV_BASE}${path}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PokéInventory/1.32.0' }
    });

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `TCGCSV returned ${res.status}` }) };
    }

    const data = await res.text();
    return { statusCode: 200, headers, body: data };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
