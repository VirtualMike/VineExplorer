// options/options.js
import { getKeywords, addKeyword, deleteKeyword, purgeRemovedProducts, exportAll, importAll } from '../db/db.js';

const SCAN_DEFAULTS = {
  PageBackgroundScanDelay:       3000,
  PageBackgroundScanRandomness:  5000,
  ETVBackgroundScanDelay:        3000,
  ETVBackgroundScanRandomness:   5000
};

async function init() {
  await loadKeywords();
  await loadScanSettings();
  await loadStats();
  bindEvents();
}

// ── Keywords ────────────────────────────────────────────────────────────────
async function loadKeywords() {
  const keywords = await getKeywords();
  const list = document.getElementById('kw-list');
  list.innerHTML = '';

  if (keywords.length === 0) {
    list.innerHTML = '<li class="kw-empty">No keywords yet.</li>';
    return;
  }

  for (const kw of keywords) {
    list.appendChild(renderKeywordItem(kw));
  }
}

function renderKeywordItem(kw) {
  const li = document.createElement('li');
  li.className = 'kw-item';
  li.dataset.id = kw.id;

  const span = document.createElement('span');
  span.className = 'kw-text';
  span.textContent = kw.keyword;

  const del = document.createElement('button');
  del.className = 'btn-delete';
  del.title = 'Remove keyword';
  del.textContent = '✕';
  del.addEventListener('click', async () => {
    await deleteKeyword(kw.id);
    li.remove();
    const list = document.getElementById('kw-list');
    if (list.children.length === 0) {
      list.innerHTML = '<li class="kw-empty">No keywords yet.</li>';
    }
  });

  li.appendChild(span);
  li.appendChild(del);
  return li;
}

async function handleAddKeyword() {
  const input = document.getElementById('kw-input');
  const raw = input.value.trim();
  if (!raw) return;

  // Support comma-separated entry
  const words = raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

  for (const word of words) {
    try {
      await addKeyword(word);
    } catch {
      // Duplicate — skip
    }
  }

  input.value = '';
  await loadKeywords();
}

// ── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (!res) return;
  document.getElementById('ds-total').textContent     = res.total     ?? 0;
  document.getElementById('ds-available').textContent = res.available  ?? 0;
  document.getElementById('ds-removed').textContent   = res.removed    ?? 0;
  document.getElementById('ds-etv').textContent       = res.withEtv    ?? 0;
}

// ── Purge ────────────────────────────────────────────────────────────────────
async function handlePurge() {
  const days    = parseInt(document.getElementById('purge-days').value, 10);
  const deleted = await purgeRemovedProducts(days);
  const result  = document.getElementById('purge-result');
  result.textContent = `Purged ${deleted} product${deleted === 1 ? '' : 's'}.`;
  result.classList.remove('hidden');
  setTimeout(() => result.classList.add('hidden'), 4000);
  await loadStats();
}

// ── Scan Settings ────────────────────────────────────────────────────────────
async function loadScanSettings() {
  const stored = await chrome.storage.local.get({ ...SCAN_DEFAULTS, weekStartDay: 0 });
  document.getElementById('page-delay').value  = stored.PageBackgroundScanDelay;
  document.getElementById('page-random').value = stored.PageBackgroundScanRandomness;
  document.getElementById('etv-delay').value   = stored.ETVBackgroundScanDelay;
  document.getElementById('etv-random').value  = stored.ETVBackgroundScanRandomness;
  document.getElementById('week-start').value  = stored.weekStartDay;
}

function saveScanSettings() {
  const settings = {
    PageBackgroundScanDelay:      Math.max(500, parseInt(document.getElementById('page-delay').value, 10) || SCAN_DEFAULTS.PageBackgroundScanDelay),
    PageBackgroundScanRandomness: Math.max(0,   parseInt(document.getElementById('page-random').value, 10) || SCAN_DEFAULTS.PageBackgroundScanRandomness),
    ETVBackgroundScanDelay:       Math.max(500, parseInt(document.getElementById('etv-delay').value, 10) || SCAN_DEFAULTS.ETVBackgroundScanDelay),
    ETVBackgroundScanRandomness:  Math.max(0,   parseInt(document.getElementById('etv-random').value, 10) || SCAN_DEFAULTS.ETVBackgroundScanRandomness),
    weekStartDay:                 parseInt(document.getElementById('week-start').value, 10) || 0
  };
  chrome.storage.local.set(settings);
  const msg = document.getElementById('scan-saved');
  msg.textContent = 'Settings saved.';
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}

// ── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('kw-add').addEventListener('click', handleAddKeyword);
  document.getElementById('kw-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyword();
  });
  document.getElementById('btn-purge').addEventListener('click', handlePurge);

  for (const id of ['page-delay', 'page-random', 'etv-delay', 'etv-random', 'week-start']) {
    document.getElementById(id).addEventListener('change', saveScanSettings);
  }

  document.getElementById('btn-rescan').addEventListener('click', handleRescan);
  document.getElementById('btn-heatmap').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_HEATMAP' });
  });
  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', handleFileSelected);
  document.getElementById('btn-import-confirm').addEventListener('click', handleImportConfirm);
}

// ── Rescan ───────────────────────────────────────────────────────────────────
async function handleRescan() {
  const btn    = document.getElementById('btn-rescan');
  const status = document.getElementById('rescan-status');

  btn.disabled = true;
  btn.textContent = 'Starting…';
  status.textContent = '';

  const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_RESCAN' });

  if (!res?.ok) {
    status.textContent = res?.error || 'Failed to start rescan.';
    btn.disabled = false;
    btn.textContent = 'Rescan Missing Data';
    return;
  }

  if (res.alreadyRunning) {
    status.textContent = 'Rescan is already running.';
    btn.disabled = false;
    btn.textContent = 'Rescan Missing Data';
    return;
  }

  btn.textContent = 'Rescanning…';
  status.textContent = 'Running — check the Vine tab status bar for progress.';

  // Listen for completion notification from the service worker
  chrome.runtime.onMessage.addListener(function listener(msg) {
    if (msg.type === 'RESCAN_COMPLETE') {
      chrome.runtime.onMessage.removeListener(listener);
      const r = msg.result || {};
      status.textContent = `Done — ${r.scanned || 0} products updated.`;
      btn.disabled = false;
      btn.textContent = 'Rescan Missing Data';
      loadStats();
    }
  });
}

// ── Export / Import ──────────────────────────────────────────────────────────
let pendingImportData = null;

async function handleExport() {
  const btn = document.getElementById('btn-export');
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    const data = await exportAll();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href     = url;
    a.download = `vine-explorer-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    const result = document.getElementById('import-result');
    result.textContent = `Exported ${data.products.length} products and ${data.keywords.length} keywords.`;
    result.classList.remove('hidden');
    setTimeout(() => result.classList.add('hidden'), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export Data';
  }
}

function handleFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      pendingImportData = JSON.parse(reader.result);
      const result = document.getElementById('import-result');
      const pCount = pendingImportData.products?.length || 0;
      const kCount = pendingImportData.keywords?.length || 0;
      result.textContent = `File loaded: ${pCount} products, ${kCount} keywords. Click "Start Import" to proceed.`;
      result.classList.remove('hidden');
      document.getElementById('import-options').classList.remove('hidden');
    } catch {
      const result = document.getElementById('import-result');
      result.textContent = 'Invalid JSON file.';
      result.classList.remove('hidden');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function handleImportConfirm() {
  if (!pendingImportData) return;
  const btn    = document.getElementById('btn-import-confirm');
  const result = document.getElementById('import-result');
  const merge  = document.getElementById('import-merge').checked;

  btn.disabled = true;
  btn.textContent = 'Importing…';
  result.textContent = 'Import in progress…';

  try {
    const stats = await importAll(pendingImportData, { mergeProducts: merge });
    result.textContent = `Imported ${stats.productsImported} products (${stats.productsSkipped} skipped), ${stats.keywordsImported} keywords.`;
    await loadKeywords();
    await loadStats();
  } catch (err) {
    result.textContent = `Import failed: ${err.message}`;
  } finally {
    pendingImportData = null;
    btn.disabled = false;
    btn.textContent = 'Start Import';
    document.getElementById('import-options').classList.add('hidden');
  }
}

init();
