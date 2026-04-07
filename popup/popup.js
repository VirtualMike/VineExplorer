// popup/popup.js
import { getKeywords } from '../db/db.js';

const VINE_URL = 'https://www.amazon.com/vine/vine-items?queue=potluck';

async function init() {
  await loadStats();
  bindButtons();
}

async function loadStats() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (!res) return;

  document.getElementById('stat-total').textContent     = res.total     ?? 0;
  document.getElementById('stat-available').textContent = res.available  ?? 0;
  document.getElementById('stat-etv').textContent       = res.withEtv    ?? 0;
  document.getElementById('stat-removed').textContent   = res.removed    ?? 0;

  const keywords = await getKeywords();
  if (keywords.length > 0) {
    document.getElementById('footer-note').textContent =
      `Watching ${keywords.length} keyword${keywords.length === 1 ? '' : 's'}`;
  }
}

function bindButtons() {
  document.getElementById('btn-compact').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('compact/compact.html') });
    window.close();
  });

  document.getElementById('btn-vine').addEventListener('click', () => {
    chrome.tabs.create({ url: VINE_URL });
    window.close();
  });

  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
