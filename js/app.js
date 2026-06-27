// app.js — PokéInventory v4 (Firebase-synced)

let lots = [];
let corrections = {};
let currentLotId = null;
let pendingCards = [];
let uploadedImageDataUrl = null;
let unsubLots = null;
let unsubCorrections = null;

// ── INIT ───────────────────────────────────────────────────────────────────
async function init() {
  // Check for local data to migrate
  if (window.DB.needsMigration()) {
    showMigrationBanner();
  }

  // Subscribe to real-time lot updates
  unsubLots = window.DB.lotsListen(updatedLots => {
    lots = updatedLots;
    const page = document.querySelector('.page.active')?.id;
    if (page === 'page-lots')   { renderLots(); updateSummary(); }
    if (page === 'page-cards')  { renderAllCards(); }
    if (page === 'page-detail') { renderDetail(currentLotId); }
    updateSummary();
  });

  // Subscribe to corrections
  unsubCorrections = window.DB.correctionsListen(map => {
    corrections = map;
  });

  showPage('lots');
}

// ── MIGRATION BANNER ───────────────────────────────────────────────────────
function showMigrationBanner() {
  const banner = document.createElement('div');
  banner.id = 'migration-banner';
  banner.style.cssText = `
    position: fixed; top: 56px; left: 0; right: 0; z-index: 80;
    background: #1A6BB5; color: white; padding: 12px 20px;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 13px; gap: 12px;
  `;
  banner.innerHTML = `
    <span>You have lots saved locally on this device. Sync them to the cloud so all your devices can see them?</span>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button onclick="runMigration()" style="background:white;color:#1A6BB5;border:none;border-radius:6px;padding:6px 14px;font-weight:600;cursor:pointer">Sync Now</button>
      <button onclick="dismissMigration()" style="background:rgba(255,255,255,0.2);color:white;border:none;border-radius:6px;padding:6px 10px;cursor:pointer">Skip</button>
    </div>
  `;
  document.body.appendChild(banner);
}

async function runMigration() {
  const banner = document.getElementById('migration-banner');
  if (banner) banner.innerHTML = '<span>Syncing your lots to the cloud...</span>';
  const count = await window.DB.migrateFromLocalStorage();
  if (banner) banner.remove();
  toast(`${count} lot${count !== 1 ? 's' : ''} synced to cloud!`, 'success');
}

function dismissMigration() {
  localStorage.setItem('pokeinv_migrated', '1');
  document.getElementById('migration-banner')?.remove();
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function lotValue(lot) {
  return (lot.cards || []).reduce((s, c) => s + (c.tcgPrice || 0), 0);
}
function lotPL(lot) { return lotValue(lot) - (lot.paid || 0); }
function condBadgeClass(c) {
  return { NM:'badge-nm', LP:'badge-lp', MP:'badge-mp', HP:'badge-hp' }[c] || 'badge-nm';
}
function fmt(n)   { return '$' + Math.abs(n || 0).toFixed(2); }
function fmtPL(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── NAVIGATION ─────────────────────────────────────────────────────────────
function showPage(name, lotId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

  if (name === 'lots') {
    document.getElementById('page-lots').classList.add('active');
    document.querySelector('[data-page="lots"]').classList.add('active');
    renderLots(); updateSummary();
  } else if (name === 'cards') {
    document.getElementById('page-cards').classList.add('active');
    document.querySelector('[data-page="cards"]').classList.add('active');
    renderAllCards();
  } else if (name === 'detail') {
    currentLotId = lotId;
    document.getElementById('page-detail').classList.add('active');
    renderDetail(lotId);
  }
}

// ── SUMMARY ────────────────────────────────────────────────────────────────
function updateSummary() {
  const spent = lots.reduce((s, l) => s + (l.paid || 0), 0);
  const value = lots.reduce((s, l) => s + lotValue(l), 0);
  const pl    = value - spent;
  document.getElementById('stat-lots').textContent  = lots.length;
  document.getElementById('stat-spent').textContent = fmt(spent);
  document.getElementById('stat-value').textContent = fmt(value);
  const plEl   = document.getElementById('stat-pl');
  plEl.textContent = fmtPL(pl);
  plEl.closest('.stat-card').className = 'stat-card ' + (pl >= 0 ? 'profit' : 'loss');
}

// ── LOTS RENDER ────────────────────────────────────────────────────────────
function renderLots(filter = '') {
  const grid  = document.getElementById('lots-grid');
  const empty = document.getElementById('lots-empty');
  const q     = filter.toLowerCase();
  const visible = lots.filter(l => (l.name||'').toLowerCase().includes(q));

  if (!lots.length) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  grid.innerHTML = visible.map(lot => {
    const val  = lotValue(lot);
    const pl   = lotPL(lot);
    const pct  = lot.paid > 0 ? Math.round((val / lot.paid) * 100) : 0;
    const hasCards = (lot.cards || []).length > 0;
    const status = hasCards ? (pl >= 0 ? 'profit' : 'loss') : 'pending';
    const badge  = status === 'pending' ? 'No cards yet'
      : (pl >= 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2);
    const imgHtml = lot.image
      ? `<img class="lot-thumb" src="${lot.image}" alt="Lot photo" loading="lazy">`
      : `<div class="lot-thumb-placeholder">📦</div>`;

    return `<div class="lot-card" onclick="showPage('detail','${lot.id}')">
      ${imgHtml}
      <div class="lot-card-header">
        <div>
          <div class="lot-name">${lot.name}</div>
          <div class="lot-date">${lot.date} · ${(lot.cards||[]).length} cards</div>
        </div>
        <span class="lot-badge ${status}">${badge}</span>
      </div>
      <div class="lot-card-body">
        <div class="lot-stats">
          <div class="lot-stat"><div class="lbl">Paid</div><div class="val">${fmt(lot.paid||0)}</div></div>
          <div class="lot-stat"><div class="lbl">TCG Value</div><div class="val">${fmt(val)}</div></div>
          <div class="lot-stat"><div class="lbl">ROI</div><div class="val">${pct}%</div></div>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(pct,200)/2}%;background:${pl>=0?'var(--green)':'var(--red)'}"></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── LOT DETAIL ─────────────────────────────────────────────────────────────
function renderDetail(lotId) {
  const lot = lots.find(l => l.id === lotId);
  if (!lot) return;
  document.getElementById('detail-lot-name').textContent = lot.name;
  const val = lotValue(lot), pl = lotPL(lot);
  const pct = lot.paid > 0 ? Math.round((val / lot.paid) * 100) : 0;

  document.getElementById('detail-summary').innerHTML = `
    <div class="stat-card"><div class="label">Amount Paid</div><div class="value">${fmt(lot.paid||0)}</div></div>
    <div class="stat-card"><div class="label">TCG Value</div><div class="value">${fmt(val)}</div></div>
    <div class="stat-card ${pl>=0?'profit':'loss'}"><div class="label">Net P/L</div><div class="value">${fmtPL(pl)}</div></div>
    <div class="stat-card"><div class="label">ROI</div><div class="value">${pct}%</div></div>
  `;

  const hero = document.getElementById('detail-hero');
  hero.innerHTML = lot.image ? `<div class="lot-hero"><img src="${lot.image}" alt="Lot photo"></div>` : '';

  const totalVal = val;
  const cards = lot.cards || [];
  document.getElementById('detail-tbody').innerHTML = !cards.length
    ? `<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:30px">No cards yet.</td></tr>`
    : cards.map((c, i) => {
        const share = totalVal > 0 ? ((c.tcgPrice||0)/totalVal)*(lot.paid||0) : 0;
        const cpl   = (c.tcgPrice||0) - share;
        const liveTag = c.priceIsLive ? `<span class="badge badge-live">live</span>` : `<span class="badge badge-est">est</span>`;
        const tcgLink = c.tcgUrl ? `<a href="${c.tcgUrl}" target="_blank" style="color:var(--blue);font-size:11px;margin-left:4px">↗</a>` : '';
        return `<tr>
          <td style="color:var(--gray-400);font-size:12px">${i+1}</td>
          <td><strong>${c.name}</strong></td>
          <td style="color:var(--gray-600)">${c.set||'—'}</td>
          <td style="color:var(--gray-600)">${c.number||'—'}</td>
          <td><span class="badge ${condBadgeClass(c.condition)}">${c.condition||'NM'}</span></td>
          <td><span class="badge badge-tcg">TCG</span> $${(c.tcgPrice||0).toFixed(2)} ${liveTag}${tcgLink}</td>
          <td class="${cpl>=0?'profit-cell':'loss-cell'}">${fmtPL(cpl)}</td>
          <td><button onclick="openEditCard('${lot.id}',${i})" class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:12px">Edit</button></td>
          <td><button onclick="removeCard('${lot.id}',${i})" style="background:none;border:none;color:var(--gray-300);cursor:pointer;font-size:16px">×</button></td>
        </tr>`;
      }).join('');
}

async function removeCard(lotId, idx) {
  if (!confirm('Remove this card?')) return;
  const lot = lots.find(l => l.id === lotId);
  if (!lot) return;
  const cards = [...(lot.cards || [])];
  cards.splice(idx, 1);
  await window.DB.lotUpdate(lotId, { cards });
  toast('Card removed');
}

// ── ALL CARDS ──────────────────────────────────────────────────────────────
function renderAllCards(nameFilter = '', lotFilter = '') {
  const select = document.getElementById('lot-filter');
  const current = select.value;
  select.innerHTML = '<option value="">All Lots</option>' +
    lots.map(l => `<option value="${l.id}" ${l.id===current?'selected':''}>${l.name}</option>`).join('');

  const rows = [];
  lots.forEach(lot => {
    if (lotFilter && lot.id !== lotFilter) return;
    const val = lotValue(lot);
    (lot.cards||[]).forEach(c => {
      if (nameFilter && !c.name.toLowerCase().includes(nameFilter.toLowerCase())) return;
      const share = val > 0 ? ((c.tcgPrice||0)/val)*(lot.paid||0) : 0;
      const cpl   = (c.tcgPrice||0) - share;
      const liveTag = c.priceIsLive ? `<span class="badge badge-live" style="margin-left:4px">live</span>` : '';
      rows.push(`<tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.set||'—'}</td>
        <td>${c.number||'—'}</td>
        <td><span class="badge ${condBadgeClass(c.condition)}">${c.condition||'NM'}</span></td>
        <td style="color:var(--blue);cursor:pointer" onclick="showPage('detail','${lot.id}')">${lot.name}</td>
        <td><span class="badge badge-tcg">TCG</span> $${(c.tcgPrice||0).toFixed(2)}${liveTag}</td>
        <td class="${cpl>=0?'profit-cell':'loss-cell'}">${fmtPL(cpl)}</td>
      </tr>`);
    });
  });

  document.getElementById('all-cards-tbody').innerHTML = rows.length
    ? rows.join('')
    : `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:30px">No cards found.</td></tr>`;
}

// ── MODALS ─────────────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function openNewLotModal() {
  pendingCards = [];
  uploadedImageDataUrl = null;
  document.getElementById('lot-name-input').value = '';
  document.getElementById('lot-paid-input').value = '';
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('identified-section').style.display = 'none';
  document.getElementById('identified-list').innerHTML = '';
  document.getElementById('ai-status').classList.remove('visible');
  openModal('modal-new-lot');
}

// ── IMAGE UPLOAD ───────────────────────────────────────────────────────────
function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    uploadedImageDataUrl = e.target.result;
    document.getElementById('preview-img').src = uploadedImageDataUrl;
    document.getElementById('upload-preview').style.display = 'block';
    await runIdentificationPipeline(uploadedImageDataUrl);
  };
  reader.readAsDataURL(file);
}

async function runIdentificationPipeline(dataUrl) {
  const statusEl   = document.getElementById('ai-status');
  const statusText = statusEl.querySelector('.ai-status-text');
  statusEl.classList.add('visible');
  statusText.textContent = 'Analyzing photo and identifying cards…';
  document.getElementById('identified-section').style.display = 'none';
  pendingCards = [];

  try {
    const cards = await window.AIApi.identifyCardsFromLot(dataUrl, (card, idx, total) => {
      statusText.textContent = `Identified ${idx} of ${total} cards — fetching prices…`;
      pendingCards = [...pendingCards, card];
      renderPendingCards();
      document.getElementById('identified-section').style.display = 'block';
    });

    if (!cards.length) {
      statusText.textContent = 'No cards detected — try a clearer photo or add manually.';
      return;
    }

    pendingCards = cards;
    // Apply corrections
    pendingCards = pendingCards.map(c => {
      const key = (c.name||'').toLowerCase().trim();
      if (corrections[key]) return { ...c, ...corrections[key], correctedFromAI: true };
      return c;
    });

    const liveCount = cards.filter(c => c.priceIsLive).length;
    statusText.textContent = `✓ ${cards.length} cards identified · ${liveCount} live TCGPlayer prices`;
    renderPendingCards();
    document.getElementById('identified-section').style.display = 'block';
  } catch (err) {
    statusText.textContent = 'Error identifying cards. Add them manually.';
    console.error(err);
  }
}

function renderPendingCards() {
  document.getElementById('identified-list').innerHTML = pendingCards.map((c, i) => {
    const priceClass = c.priceIsLive ? 'live' : 'est';
    const priceLabel = c.priceIsLive ? `$${c.tcgPrice.toFixed(2)}` : `~$${c.tcgPrice.toFixed(2)}`;
    return `<div class="id-card">
      <div class="id-num">${i+1}</div>
      <div class="id-info">
        <div class="name">${c.name}${c.correctedFromAI?'<span style="font-size:10px;color:#f57f17;margin-left:4px">✓ corrected</span>':''}</div>
        <div class="meta">${c.set||''}${c.number?' · #'+c.number:''} · ${c.condition||'NM'}</div>
      </div>
      <div class="id-price ${priceClass}">${priceLabel}</div>
      <button class="btn btn-ghost btn-sm" style="padding:3px 8px;font-size:11px" onclick="openCorrectCard(${i})">Fix</button>
      <button class="id-remove" onclick="removePending(${i})">×</button>
    </div>`;
  }).join('');
}

function removePending(i) { pendingCards.splice(i, 1); renderPendingCards(); }

// ── CORRECTION FLOW ────────────────────────────────────────────────────────
let correctingIndex = null;

function openCorrectCard(i) {
  correctingIndex = i;
  const c = pendingCards[i];
  document.getElementById('cc-original').textContent = c.name;
  document.getElementById('cc-name').value      = c.name;
  document.getElementById('cc-set').value       = c.set || '';
  document.getElementById('cc-number').value    = c.number || '';
  document.getElementById('cc-condition').value = c.condition || 'NM';
  document.getElementById('cc-price').value     = c.tcgPrice || '';
  openModal('modal-correct-card');
}

async function saveCorrection() {
  const i = correctingIndex;
  if (i === null) return;
  const name = document.getElementById('cc-name').value.trim();
  const set  = document.getElementById('cc-set').value.trim();
  const number = document.getElementById('cc-number').value.trim();
  const condition = document.getElementById('cc-condition').value;
  const priceVal  = parseFloat(document.getElementById('cc-price').value) || 0;
  const original  = pendingCards[i].name;

  await window.DB.correctionSave(original, { name, set, number, condition });

  let card = { ...pendingCards[i], name, set, number, condition, correctedFromAI: true };
  if (name !== original || !priceVal) {
    const result = await window.TCGApi.lookupCardPrice(name, set);
    if (result) { card.tcgPrice = result.price; card.priceIsLive = true; card.tcgUrl = result.tcgUrl; }
    else if (priceVal) { card.tcgPrice = priceVal; }
  } else { card.tcgPrice = priceVal; }

  pendingCards[i] = card;
  closeModal('modal-correct-card');
  renderPendingCards();
  toast('Correction saved — synced across all devices', 'success');
}

// ── SAVE LOT ───────────────────────────────────────────────────────────────
async function saveLot() {
  const name = document.getElementById('lot-name-input').value.trim();
  const paid = parseFloat(document.getElementById('lot-paid-input').value) || 0;
  if (!name) { toast('Please enter a lot name.', 'error'); return; }

  const btn = document.querySelector('#modal-new-lot .btn-primary');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    const lotId = await window.DB.lotAdd({
      name, paid,
      date:  new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
      cards: [...pendingCards],
      image: uploadedImageDataUrl || null
    });

    closeModal('modal-new-lot');
    showPage('lots');
    toast(`Lot "${name}" saved with ${pendingCards.length} cards — synced to all devices!`, 'success');
  } catch (err) {
    toast('Error saving lot. Check your connection.', 'error');
    console.error(err);
  } finally {
    btn.textContent = 'Save Lot'; btn.disabled = false;
  }
}

// ── ADD / EDIT CARD ────────────────────────────────────────────────────────
function openAddCardModal() {
  document.getElementById('ac-name').value      = '';
  document.getElementById('ac-set').value       = '';
  document.getElementById('ac-number').value    = '';
  document.getElementById('ac-condition').value = 'NM';
  document.getElementById('ac-price').value     = '';
  document.getElementById('ac-lot-id').value    = currentLotId;
  document.getElementById('ac-card-idx').value  = '';
  document.getElementById('ac-save-correction').style.display = 'none';
  openModal('modal-add-card');
}

function openEditCard(lotId, idx) {
  const lot = lots.find(l => l.id === lotId);
  if (!lot) return;
  const c = lot.cards[idx];
  document.getElementById('ac-name').value      = c.name || '';
  document.getElementById('ac-set').value       = c.set || '';
  document.getElementById('ac-number').value    = c.number || '';
  document.getElementById('ac-condition').value = c.condition || 'NM';
  document.getElementById('ac-price').value     = c.tcgPrice || '';
  document.getElementById('ac-lot-id').value    = lotId;
  document.getElementById('ac-card-idx').value  = idx;
  document.getElementById('ac-save-correction').style.display = 'block';
  document.getElementById('ac-original-name').value = c.name || '';
  openModal('modal-add-card');
}

async function saveCard() {
  const name     = document.getElementById('ac-name').value.trim();
  const set      = document.getElementById('ac-set').value.trim();
  const number   = document.getElementById('ac-number').value.trim();
  const cond     = document.getElementById('ac-condition').value;
  const priceVal = parseFloat(document.getElementById('ac-price').value) || 0;
  const lotId    = document.getElementById('ac-lot-id').value;
  const editIdx  = document.getElementById('ac-card-idx').value;
  const saveCorr = document.getElementById('ac-correction-checkbox')?.checked;
  const origName = document.getElementById('ac-original-name').value;

  if (!name) { toast('Card name is required.', 'error'); return; }

  const lot = lots.find(l => l.id === lotId);
  if (!lot) return;

  let card = { name, set, number, condition: cond, tcgPrice: priceVal, priceIsLive: false, tcgUrl: null };

  if (!priceVal) {
    const result = await window.TCGApi.lookupCardPrice(name, set);
    if (result) { card.tcgPrice = result.price; card.priceIsLive = true; card.tcgUrl = result.tcgUrl; }
  }

  if (saveCorr && origName && origName !== name) {
    await window.DB.correctionSave(origName, { name, set, number, condition: cond });
  }

  const cards = [...(lot.cards || [])];
  if (editIdx !== '') { cards[parseInt(editIdx)] = card; }
  else { cards.push(card); }

  await window.DB.lotUpdate(lotId, { cards });
  closeModal('modal-add-card');
  toast(editIdx !== '' ? 'Card updated.' : 'Card added.', 'success');
}

// ── DELETE LOT ─────────────────────────────────────────────────────────────
async function deleteLot(lotId) {
  const lot = lots.find(l => l.id === lotId);
  if (!confirm(`Delete lot "${lot?.name}"? This cannot be undone.`)) return;
  await window.DB.lotDelete(lotId);
  showPage('lots');
  toast('Lot deleted.', 'success');
}

// ── CORRECTIONS VIEWER ─────────────────────────────────────────────────────
function openCorrectionsModal() {
  const list = document.getElementById('corrections-list');
  const keys = Object.keys(corrections);
  if (!keys.length) {
    list.innerHTML = '<p style="color:var(--gray-400);text-align:center;padding:20px">No corrections saved yet.</p>';
  } else {
    list.innerHTML = keys.map(k => `
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--gray-200)">
        <div style="color:var(--gray-600);font-size:13px">${k}</div>
        <div style="font-weight:500;font-size:13px">→ ${corrections[k].name || k}</div>
        <button onclick="deleteCorrection('${k}')" style="background:none;border:none;color:var(--gray-400);cursor:pointer;font-size:16px">×</button>
      </div>
    `).join('');
  }
  openModal('modal-corrections');
}

async function deleteCorrection(key) {
  await window.DB.correctionDelete(key);
  openCorrectionsModal();
}

// ── EXPORT ─────────────────────────────────────────────────────────────────
function exportInventory() {
  if (!lots.length) { toast('No lots to export.', 'error'); return; }
  window.ExportApi.exportToCSV(lots);
  toast('Exported!', 'success');
}

// ── EVENT LISTENERS ────────────────────────────────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ── START ──────────────────────────────────────────────────────────────────
init();
