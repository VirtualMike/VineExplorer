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
  searchProducts
} from '../db/db.js';

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
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

// ── Alarm: periodic availability check ───────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'availability-check') {
    await runAvailabilityCheck();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('availability-check', { periodInMinutes: 30 });
});

async function runAvailabilityCheck() {
  // Only meaningful when user has a Vine tab open.
  // This alarm is a placeholder — actual availability is checked
  // passively by the content script as the user browses.
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/*' });
  if (tabs.length === 0) return;

  // Ping the content script in the active Vine tab to re-scrape visible products.
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_RESCRAPE' }).catch(() => {
      // Content script may not be ready; ignore.
    });
  }
}
