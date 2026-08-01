// background/service-worker.js — MV3 service worker for Vine Explorer
import {
  upsertProduct,
  getProduct,
  getProductCount,
  getAllProducts,
  markProductUnavailable,
  markUnseenAsUnavailable,
  markOlderThanDaysUnavailable,
  purgeRemovedProducts,
  getKeywords,
  addKeyword,
  deleteKeyword,
  searchProducts,
  getScanState,
  updateScanState,
  resetScanState,
  upsertOrders,
  getAllOrders
} from '../db/db.js';
import { parseXlsx } from '../lib/xlsx.js';

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

    case 'MARK_UNSEEN_UNAVAILABLE': {
      const marked = await markUnseenAsUnavailable(new Set(msg.seenAsins || []));
      return { ok: true, marked };
    }

    case 'MARK_OLDER_UNAVAILABLE': {
      const marked = await markOlderThanDaysUnavailable(msg.days);
      return { ok: true, marked };
    }

    case 'PURGE_REMOVED': {
      const deleted = await purgeRemovedProducts(msg.olderThanDays ?? 30);
      return { ok: true, deleted };
    }

    case 'OPEN_COMPACT':
      chrome.tabs.create({ url: chrome.runtime.getURL('compact/compact.html') });
      return { ok: true };

    case 'OPEN_HEATMAP':
      chrome.tabs.create({ url: chrome.runtime.getURL('heatmap/heatmap.html') });
      return { ok: true };

    case 'OPEN_ORDERS':
      chrome.tabs.create({ url: chrome.runtime.getURL('orders/orders.html') });
      return { ok: true };

    // ── Orders ─────────────────────────────────────────────────────────────
    case 'IMPORT_ORDER_BYTES': {
      const bytes = base64ToBytes(msg.b64);
      const { rows } = await parseXlsx(bytes);
      const mapped = rows
        .map(r => mapReportRow(r, msg.year))
        .filter(Boolean);
      const stats = await upsertOrders(mapped);
      return { ok: true, ...stats, parsed: mapped.length };
    }

    case 'GET_ALL_ORDERS':
      return { orders: await getAllOrders() };

    case 'TRIGGER_ORDER_IMPORT': {
      const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/account*' });
      if (tabs.length === 0) {
        return { ok: false, error: 'No Vine account tab open. Open amazon.com/vine/account first.' };
      }
      try {
        const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_ORDER_IMPORT', years: msg.years });
        return { ok: true, ...res };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

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

// ── Orders helpers ──────────────────────────────────────────────────────────
function mapReportRow(row, year) {
  const orderNumber = String(row['Order Number'] || '').trim();
  const asin        = String(row['ASIN'] || '').trim();
  const orderType   = String(row['Order Type'] || 'ORDER').trim();
  if (!orderNumber || !asin) return null;

  const etvRaw = row['Estimated Tax Value'];
  const etv    = typeof etvRaw === 'number' ? etvRaw : parseFloat(String(etvRaw).replace(/[$,]/g, '')) || 0;

  return {
    key:           `${orderNumber}|${asin}|${orderType}`,
    orderNumber,
    asin,
    productName:   String(row['Product Name'] || '').trim(),
    orderType,
    orderDate:     parseMdY(row['Order Date']),
    shippedDate:   parseMdY(row['Shipped Date']),
    cancelledDate: parseMdY(row['Cancelled Date']),
    etv,
    reportYear:    year
  };
}

// "MM/DD/YYYY" -> epoch ms (local midnight), or null if blank/unparseable.
function parseMdY(s) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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

// ── Alarms ────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'background-scan') {
    await triggerBackgroundScan();
  } else if (alarm.name === 'orders-daily-import') {
    await triggerDailyOrderImport();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('background-scan', { periodInMinutes: 30 });
  chrome.alarms.create('orders-daily-import', {
    when:            next3amEpoch(),
    periodInMinutes: 1440
  });
});

// Next 03:07 local time as epoch ms (off-the-hour to avoid fleet pileups).
function next3amEpoch() {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 7, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function triggerBackgroundScan() {
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/*' });
  if (tabs.length === 0) return;
  try {
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'START_BACKGROUND_SCAN' });
  } catch (err) {
    console.log('[VineExplorer SW] Could not reach Vine tab:', err.message);
  }
}

async function triggerDailyOrderImport() {
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/vine/account*' });
  const thisYear = new Date().getFullYear();

  if (tabs.length === 0) {
    // No account tab open — prompt the user to open one so we can import.
    try {
      chrome.notifications.create('vine-orders-reminder', {
        type:    'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title:   'Vine Explorer — Order Import',
        message: 'Open amazon.com/vine/account to import your latest orders into the dashboard.'
      }, () => { void chrome.runtime.lastError; }); // ignore missing-icon error
    } catch { /* notifications may be unavailable */ }
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabs[0].id, {
      type:  'TRIGGER_ORDER_IMPORT',
      years: [thisYear, thisYear - 1]
    });
    console.log('[VineExplorer SW] Daily order import triggered');
  } catch (err) {
    console.log('[VineExplorer SW] Daily order import could not reach account tab:', err.message);
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
