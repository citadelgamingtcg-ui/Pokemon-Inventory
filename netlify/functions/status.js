// Diagnostic endpoint — visit /.netlify/functions/status to check API health
const TCGAPI_KEY = process.env.TCGAPI_KEY;

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  const result = { time: new Date().toISOString(), checks: {} };

  // Check 1: Is the tcgapi.dev key set?
  result.checks.tcgapi_key_set = !!TCGAPI_KEY;
  result.checks.tcgapi_key_preview = TCGAPI_KEY ? TCGAPI_KEY.slice(0,12)+'...' : 'NOT SET';

  // Check 2: Can we reach tcgapi.dev? Test with "Charizard"
  if (TCGAPI_KEY) {
    try {
      const r = await fetch('https://api.tcgapi.dev/v1/search?q=Charizard&game=pokemon&per_page=3', {
        headers: { 'X-API-Key': TCGAPI_KEY }
      });
      result.checks.tcgapi_status = r.status;
      if (r.ok) {
        const d = await r.json();
        result.checks.tcgapi_results = (d.data||[]).length;
        result.checks.tcgapi_first_card = d.data?.[0] ? {
          name: d.data[0].name,
          set: d.data[0].set_name,
          number: d.data[0].number,
          market_price: d.data[0].market_price
        } : null;
        result.checks.tcgapi_rate_limit = d.rate_limit || 'not reported';
      } else {
        result.checks.tcgapi_error = (await r.text()).slice(0,200);
        if (r.status === 429) result.checks.tcgapi_note = 'RATE LIMITED — out of daily requests, resets UTC midnight';
      }
    } catch(e) { result.checks.tcgapi_exception = e.message; }
  }

  // Check 3: Can we reach TCGCSV?
  try {
    const r = await fetch('https://tcgcsv.com/tcgplayer/3/groups', {
      headers: { 'User-Agent': 'PokeInventory/2.8' }
    });
    result.checks.tcgcsv_status = r.status;
    if (r.ok) {
      const d = await r.json();
      result.checks.tcgcsv_groups = (d.results||[]).length;
    } else {
      result.checks.tcgcsv_note = r.status === 403 ? 'BLOCKED (403) — TCGCSV refusing Netlify IP' : 'failed';
    }
  } catch(e) { result.checks.tcgcsv_exception = e.message; }

  return { statusCode: 200, headers, body: JSON.stringify(result, null, 2) };
};
