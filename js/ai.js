// ai.js — Card identification
// Strategy: Claude vision API to identify cards from lot photo
// Falls back gracefully if API fails

const CORRECTIONS_KEY = 'pokeinv_corrections';

function getCorrections() {
  try { return JSON.parse(localStorage.getItem(CORRECTIONS_KEY) || '{}'); } catch { return {}; }
}

window.AIApi = {

  /**
   * Identify cards from a lot photo using Claude.
   * onProgress(card, idx, total) called as each card resolves.
   */
  async identifyCardsFromLot(dataUrl, onProgress) {
    // Step 1: Compress image for API
    const compressed = await compressForClaude(dataUrl);

    // Step 2: Ask Claude to identify all cards
    let claudeCards = [];
    try {
      claudeCards = await callClaude(compressed);
    } catch(err) {
      console.error('Claude API error:', err);
      throw new Error('Could not reach the AI service. Check your internet connection and try again.');
    }

    if (!claudeCards.length) return [];

    const total = claudeCards.length;
    const results = [];

    // Step 3: For each card Claude identified, try to get a live price
    for (let i = 0; i < claudeCards.length; i++) {
      const c = claudeCards[i];
      let card = {
        name:        c.name || 'Unknown Card',
        set:         c.set  || '',
        number:      c.number || '',
        condition:   c.condition || 'NM',
        tcgPrice:    parseFloat(c.estimatedPrice) || 0,
        priceIsLive: false,
        tcgUrl:      null
      };

      // Try live price lookup
      try {
        const priceResult = await window.TCGApi.lookupCardPrice(card.name, card.set, card.number);
        if (priceResult) {
          card.tcgPrice    = priceResult.price;
          card.priceIsLive = true;
          card.tcgUrl      = priceResult.tcgUrl || null;
        }
      } catch(e) {
        // Keep estimated price — not fatal
      }

      // Apply saved corrections
      const corrections = getCorrections();
      const key = card.name.toLowerCase().trim();
      if (corrections[key]) {
        card = { ...card, ...corrections[key], correctedFromAI: true };
      }

      results.push(card);
      if (onProgress) onProgress(card, i + 1, total);
    }

    return results;
  },

  saveCorrection(originalName, corrected) {
    const corrections = getCorrections();
    corrections[originalName.toLowerCase().trim()] = corrected;
    localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(corrections));
  },

  getCorrections,

  applyCorrections(cards) {
    const corrections = getCorrections();
    return cards.map(c => {
      const key = (c.name || '').toLowerCase().trim();
      return corrections[key] ? { ...c, ...corrections[key], correctedFromAI: true } : c;
    });
  }
};

// ── CLAUDE API CALL ────────────────────────────────────────────────────────
async function callClaude(dataUrl) {
  const base64   = dataUrl.split(',')[1];
  const mimeType = dataUrl.split(';')[0].split(':')[1] || 'image/jpeg';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64 }
          },
          {
            type: 'text',
            text: `You are a Pokémon TCG expert. Look at this image and identify every Pokémon card visible.

Return a JSON array only — no markdown, no explanation, just the array:
[
  {
    "name": "full card name as printed",
    "set": "set name",
    "number": "collector number or empty string",
    "condition": "NM or LP or MP or HP",
    "estimatedPrice": 0.00
  }
]

If no Pokémon cards are visible, return [].
Only include cards you can actually identify. Be specific with card names including suffixes like V, VMAX, ex, EX, GX.`
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = (data.content?.[0]?.text || '').trim();

  // Parse JSON — handle various formats Claude might return
  try {
    // Direct parse
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.cards || []);
  } catch {
    // Try to extract array from text
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    // Nothing parseable
    console.warn('Could not parse Claude response:', text);
    return [];
  }
}

// ── IMAGE COMPRESSION ──────────────────────────────────────────────────────
// Claude accepts images up to ~5MB base64, but smaller = faster on mobile
function compressForClaude(dataUrl, maxWidthHeight = 1200) {
  return new Promise(resolve => {
    if (!dataUrl || !dataUrl.startsWith('data:')) { resolve(dataUrl); return; }
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w <= maxWidthHeight && h <= maxWidthHeight) { resolve(dataUrl); return; }
      const ratio = Math.min(maxWidthHeight / w, maxWidthHeight / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
