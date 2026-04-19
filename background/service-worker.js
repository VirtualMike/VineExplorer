// background/service-worker.js — MV3 service worker for Vine Explorer
import {
  upsertProduct,
  getProduct,
  getProductCount,
  getAllProducts,
  markProductUnavailable,
  purgeRemovedProducts,
  getKeywords,
  addKeyword,
  deleteKeyword,
  searchProducts,
  getScanState,
  updateScanState,
  resetScanState
} from '../db/db.js';

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let responded = false;

  handleMessage(msg, sender)
    .then((response) => {
      if (!responded) {
        responded = true;
        sendResponse(response);
      }
    })
    .catch((err) => {
      if (!responded) {
        responded = true;
        sendResponse({ error: err?.message || String(err) });
      }
    });

  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'SAVE_PRODUCT': {
      const keywords = await getKeywords();
      const matched  = matchKeywords(msg.product, keywords.map(k => k.keyword));
      const product  = { ...msg.product, keywordsMatched: matched };
      const saved    = await upsertProduct(product);

      if (matched.length > 0) {
        notifyKeywordMatch(saved, matched);
      }

      return { ok: true, product: saved };
    }

    case 'GET_PRODUCT':
      return { product: await getProduct(msg.asin) };

    case 'GET_KEYWORDS':
      return { keywords: await getKeywords() };

    case 'ADD_KEYWORD': {
      const id = await addKeyword(msg.keyword);
      return { ok: true, id };
    }

    case 'DELETE_KEYWORD':
      await deleteKeyword(msg.id);
      return { ok: true };

    case 'GET_ALL_PRODUCTS':
      return { products: await getAllProducts({ includeRemoved: msg.includeRemoved ?? false }) };

    case 'SEARCH_PRODUCTS':
      return {
        products: await searchProducts(msg.query ?? '', {
          includeRemoved: msg.includeRemoved ?? false,
          minEtv:        msg.minEtv,
          maxEtv:        msg.maxEtv,
          keywordsOnly:  msg.keywordsOnly ?? false
        })
      };

    case 'GET_STATS': {
      const all   = await getAllProducts({ includeRemoved: true });
      const total = all.length;
      const avail = all.filter(p => p.available !== false).length;
      const withEtv = all.filter(p => p.etv !== null).length;
      return { total, available: avail, removed: total - avail, withEtv };
    }

    case 'MARK_UNAVAILABLE':
      return { product: await markProductUnavailable(msg.asin) };

    case 'PURGE_REMOVED': {
      const deleted = await purgeRemovedProducts(msg.olderThanDays ?? 30);
      return { ok: true, deleted };
    }

    case 'OPEN_COMPACT':
      chrome.tabs.create({ url: chrome.runtime.getURL('compact/compact.html') });
      return { ok: true };

    // ── Scan coordination ──────────────────────────────────────────────────
    case 'CLAIM_SCAN_LOCK': {
      const state = await getScanState();
      const STALE_MS = 5 * 60_000; // 5 minutes
      const isStale  = state.lastActivity && (Date.now() - state.lastActivity > STALE_MS);

      if (state.status === 'running' && state.scanningTabId && !isStale) {
        // Check if the holding tab is still alive
        try {
          await chrome.tabs.get(state.scanningTabId);
          return { granted: false, reason: 'another tab is scanning' };
        } catch {
          // Tab is gone — fall through and grant
        }
      }

      await updateScanState({
        status:        'running',
        scanningTabId: sender.tab?.id ?? null,
        lastActivity:  Date.now()
      });
      return { granted: true, state: await getScanState() };
    }

    case 'RELEASE_SCAN_LOCK': {
      await updateScanState({ status: 'idle', scanningTabId: null });
      return { ok: true };
    }

    case 'GET_SCAN_STATE':
      return { state: await getScanState() };

    case 'UPDATE_SCAN_STATE': {
      const updated = await updateScanState({ ...msg.patch, lastActivity: Date.now() });
      return { ok: true, state: updated };
    }

    case 'RESET_SCAN_STATE': {
      await resetScanState();
      return { ok: true };
    }

    case 'TRIGGER_RESCAN': {
      const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/*' });
      if (tabs.length === 0) {
        return { ok: false, error: 'No Vine tab open. Open any Amazon Vine page first.' };
      }
      try {
        const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'START_RESCAN' });
        return { ok: true, alreadyRunning: res?.alreadyRunning };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ── Keyword matching ──────────────────────────────────────────────────────────
function matchKeywords(product, keywords) {
  if (!keywords || keywords.length === 0) return [];
  const hay = `${product.title} ${product.description}`.toLowerCase();
  return keywords.filter(kw => hay.includes(kw));
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notifyKeywordMatch(product, matched) {
  const etv  = product.etv !== null ? ` — ETV $${product.etv.toFixed(2)}` : '';
  const kwds = matched.join(', ');
  chrome.notifications.create(`vine-match-${product.asin}`, {
    type:    'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title:   `Vine Explorer: Keyword match (${matched.length})`,
    message: `${product.title.slice(0, 80)}${etv}\nKeywords: ${kwds}`
  });
}

// ── Alarm: periodic background scan trigger ──────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'background-scan') {
    await triggerBackgroundScan();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('background-scan', { periodInMinutes: 30 });
});

async function triggerBackgroundScan() {
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/*' });
  if (tabs.length === 0) return;
  try {
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'START_BACKGROUND_SCAN' });
  } catch (err) {
    console.log('[VineExplorer SW] Could not reach Vine tab:', err.message);
  }
}

// ── Stale scan lock cleanup ──────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const state = await getScanState();
    if (state?.scanningTabId === tabId) {
      await updateScanState({ status: 'paused', scanningTabId: null });
      console.log('[VineExplorer SW] Scanning tab closed — scan paused for resume');
    }
  } catch { /* DB not ready yet — ignore */ }
});
