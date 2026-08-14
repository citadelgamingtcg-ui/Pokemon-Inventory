// export.js — CSV exports for inventory and TCGPlayer

function escapeCsv(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadCsv(rows, filename) {
  const csv  = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── STANDARD INVENTORY EXPORT ──────────────────────────────────────────────
function exportToCSV(lots) {
  const rows = [
    ['Lot Name','Date','Amount Paid','Card Name','Set','Number','Rarity','Condition','Qty','TCG Market Price','Total Value','P/L Share','Sold Price','Sold Platform','Sold Date','TCG URL']
  ];

  lots.forEach(lot => {
    const totalVal = (lot.cards||[]).reduce((s,c) => s+((c.tcgPrice||0)*(c.qty||1)), 0);
    (lot.cards||[]).forEach(card => {
      const qty   = card.qty || 1;
      const total = (card.tcgPrice||0) * qty;
      const share = totalVal > 0 ? (total/totalVal)*(lot.paid||0) : 0;
      const pl    = total - share;
      rows.push([
        lot.name, lot.date, (lot.paid||0).toFixed(2),
        card.name, card.set||'', card.number||'', card.rarity||'',
        card.condition||'NM', qty,
        (card.tcgPrice||0).toFixed(2), total.toFixed(2), pl.toFixed(2),
        card.soldPrice ? card.soldPrice.toFixed(2) : '',
        card.soldPlatform || '', card.soldDate || '',
        card.tcgUrl || ''
      ]);
    });
    // Lot subtotal
    if ((lot.cards||[]).length > 0) {
      const pl = totalVal - (lot.paid||0);
      rows.push([`TOTAL: ${lot.name}`, lot.date, (lot.paid||0).toFixed(2),
        '','','','','','', totalVal.toFixed(2), totalVal.toFixed(2), pl.toFixed(2),'','','','']);
      rows.push([]);
    }
  });

  downloadCsv(rows, `pokeinventory-${new Date().toISOString().slice(0,10)}.csv`);
}

// ── TCGPLAYER EXPORT ───────────────────────────────────────────────────────
// TCGPlayer Mass Entry CSV format:
// https://help.tcgplayer.com/hc/en-us/articles/201760937
//
// Columns: Quantity, Name, Set, Condition, Printing, Price, SKU (we use lot name)
//
// Condition mapping:
//   NM → Near Mint
//   LP → Lightly Played
//   MP → Moderately Played
//   HP → Heavily Played
//
// Printing mapping (rarity hints):
//   If rarity contains "Reverse" → Reverse Holofoil
//   If rarity contains "Holo" or "Foil" → Holofoil
//   Otherwise → Normal

const COND_MAP = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played'
};

function rarityToPrinting(rarity) {
  if (!rarity) return 'Normal';
  const r = rarity.toLowerCase();
  if (r.includes('reverse')) return 'Reverse Holofoil';
  if (r.includes('holo') || r.includes('foil')) return 'Holofoil';
  return 'Normal';
}

function exportToTCGPlayer(lots, filterLotId = null) {
  // TCGPlayer header
  const rows = [
    ['Quantity','Name','Set Name','Number','Condition','Printing','Add to Quantity','Price','SKU/Lot']
  ];

  let cardCount = 0;

  lots.forEach(lot => {
    if (filterLotId && lot.id !== filterLotId) return;
    (lot.cards||[]).forEach(card => {
      if (card.soldPrice) return; // Skip already sold cards
      const qty       = card.qty || 1;
      const condition = COND_MAP[card.condition] || 'Near Mint';
      const printing  = rarityToPrinting(card.rarity);
      const price     = card.tcgPrice ? card.tcgPrice.toFixed(2) : '';
      rows.push([
        qty,
        card.name,
        card.set || '',
        card.number || '',
        condition,
        printing,
        'Yes',    // Add to existing quantity rather than overwrite
        price,
        lot.name  // SKU = lot name so you can trace it back
      ]);
      cardCount++;
    });
  });

  if (cardCount === 0) return false;

  const suffix = filterLotId
    ? lots.find(l=>l.id===filterLotId)?.name?.replace(/[^a-z0-9]/gi,'_') || 'lot'
    : 'all';
  downloadCsv(rows, `tcgplayer-upload-${suffix}-${new Date().toISOString().slice(0,10)}.csv`);
  return cardCount;
}

window.ExportApi = { exportToCSV, exportToTCGPlayer };
