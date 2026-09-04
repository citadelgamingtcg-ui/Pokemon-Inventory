// Cloudflare diagnostic — visit /status
export async function onRequest(context) {
  const { env } = context;
  const headers = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  const result = { time: new Date().toISOString(), platform: 'cloudflare', checks: {} };

  // DIAGNOSTIC: list all env variable NAMES that Cloudflare is passing (not values)
  try {
    result.env_keys_available = Object.keys(env || {});
    result.env_type = typeof env;
  } catch(e) {
    result.env_error = e.message;
  }

  const TCGAPI_KEY = env?.TCGAPI_KEY;
  result.checks.tcgapi_key_set = !!TCGAPI_KEY;
  result.checks.anthropic_key_set = !!(env?.ANTHROPIC_API_KEY);

  if (TCGAPI_KEY) {
    try {
      const r = await fetch('https://api.tcgapi.dev/v1/search?q=Charizard&game=pokemon&per_page=3', {
        headers: { 'X-API-Key': TCGAPI_KEY }
      });
      result.checks.tcgapi_status = r.status;
      if (r.ok) result.checks.tcgapi_results = ((await r.json()).data||[]).length;
      else if (r.status === 429) result.checks.tcgapi_note = 'RATE LIMITED';
    } catch(e) { result.checks.tcgapi_exception = e.message; }
  }

  try {
    const r = await fetch('https://tcgcsv.com/tcgplayer/3/groups', { headers: { 'User-Agent': 'PokeInventory/3.0' } });
    result.checks.tcgcsv_status = r.status;
    if (r.ok) result.checks.tcgcsv_groups = ((await r.json()).results||[]).length;
  } catch(e) { result.checks.tcgcsv_exception = e.message; }

  return new Response(JSON.stringify(result, null, 2), { status: 200, headers });
}
