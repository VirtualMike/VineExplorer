// options/options.js
import { getKeywords, addKeyword, deleteKeyword, purgeRemovedProducts } from '../db/db.js';

async function init() {
  await loadKeywords();
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

// ── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('kw-add').addEventListener('click', handleAddKeyword);
  document.getElementById('kw-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyword();
  });
  document.getElementById('btn-purge').addEventListener('click', handlePurge);
}

init();
