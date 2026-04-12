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
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/*' });
  if (tabs.length === 0) return;

  const tab = tabs[0]; // Use the first Vine tab

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGINATION_INFO' });
    const { current, total } = response;

    if (current >= total) return; // Already on last page

    // Scan remaining pages
    for (let page = current + 1; page <= total; page++) {
      const url = new URL(tab.url);
      url.searchParams.set('page', page);
      await chrome.tabs.update(tab.id, { url: url.toString() });

      // Wait for page load
      await new Promise((resolve) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      // Rescrape the new page
      chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_RESCRAPE' }).catch(() => {});

      // Delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } catch (err) {
    console.error('Error during availability check:', err);
  }
}
