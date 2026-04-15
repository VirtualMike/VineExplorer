// content/content.js — Vine Explorer content script
// Runs on: https://www.amazon.com/vine/vine-items*
// NOTE: All DB access goes through chrome.runtime.sendMessage to the service worker.

(function VineExplorer() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let keywords       = [];
  let statusBar      = null;
  let processedAsins = new Set();
  let fetchQueue     = [];
  let isFetching     = false;

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    console.log('[VineExplorer] Initializing…');
    await loadKeywords();
    injectStatusBar();
    await processAllTiles();   // wait so fetchQueue is fully populated
    observePageChanges();
    watchDetailPanel();
    listenForRescrape();
    updateStatusCount();
    // Start auto-fetch after page settles
    setTimeout(runFetchQueue, 3000);
  }

  // ── Keywords ───────────────────────────────────────────────────────────────
  async function loadKeywords() {
    const res = await send({ type: 'GET_KEYWORDS' });
    keywords  = (res.keywords || []).map(k => k.keyword);
    console.log('[VineExplorer] Keywords loaded:', keywords);
  }

  // ── Status bar ─────────────────────────────────────────────────────────────
  function injectStatusBar() {
    if (document.getElementById('ve-status-bar')) return;
    statusBar = document.createElement('div');
    statusBar.id = 've-status-bar';
    statusBar.innerHTML = `
      <span id="ve-status-text">Vine Explorer active</span>
      <button id="ve-open-compact" title="Open compact view">&#9776; Compact View</button>
    `;
    document.body.appendChild(statusBar);
    document.getElementById('ve-open-compact').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_COMPACT' });
    });
  }

  function setStatus(text) {
    const el = document.getElementById('ve-status-text');
    if (el) el.textContent = text;
  }

  async function updateStatusCount() {
    const res = await send({ type: 'GET_STATS' });
    if (res?.available !== undefined) {
      setStatus(`Vine Explorer — ${res.available} products cached`);
    }
  }

  // ── Tile processing ────────────────────────────────────────────────────────
  async function processAllTiles() {
    const tiles = Array.from(document.querySelectorAll('.vvp-item-tile'));
    console.log(`[VineExplorer] Found ${tiles.length} tiles`);
    await Promise.all(tiles.map(tile => processTile(tile)));
  }

  async function processTile(tile) {
    const asin = extractAsin(tile);
    if (!asin || processedAsins.has(asin)) return;
    processedAsins.add(asin);

    const product = extractProductFromTile(tile, asin);
    if (!product) return;

    // Try to read ETV directly from tile markup (usually absent, but worth checking)
    const etvFromTile = extractEtvFromTile(tile);
    if (etvFromTile !== null) product.etv = etvFromTile;

    const res   = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    if (saved) {
      enhanceTile(tile, saved);
      // Queue for auto-fetch if ETV not yet known
      if (saved.etv === null) enqueueForFetch(tile, asin);
    }
  }

  function extractAsin(tile) {
    const btn = tile.querySelector('input[data-recommendation-id], input[data-asin]');
    if (btn) {
      const recId       = btn.getAttribute('data-recommendation-id') || '';
      const asinFromRec = recId.split('|').find(p => /^[A-Z0-9]{10}$/.test(p));
      if (asinFromRec) return asinFromRec;
      const direct = btn.getAttribute('data-asin');
      if (direct) return direct;
    }
    const tileAsin = tile.getAttribute('data-asin');
    if (tileAsin) return tileAsin;
    const link = tile.querySelector('a[href*="/dp/"]');
    if (link) {
      const match = link.href.match(/\/dp\/([A-Z0-9]{10})/);
      if (match) return match[1];
    }
    return null;
  }

  function extractProductFromTile(tile, asin) {
    const titleEl = tile.querySelector(
      '.vvp-item-product-title-container a span, ' +
      '.vvp-item-product-title-container span.a-truncate-cut, ' +
      '.vvp-item-product-title-container span'
    );
    const imgEl = tile.querySelector('img');
    return {
      asin,
      title:    titleEl?.textContent?.trim() || '',
      imageUrl: imgEl?.src || imgEl?.getAttribute('data-src') || '',
      available: true
    };
  }

  // Attempt to read ETV from tile markup (Vine normally doesn't expose this,
  // but included as a future-proof fallback).
  function extractEtvFromTile(tile) {
    if (!tile) return null;

    const selectors = [
      '[data-etv]', '[data-tax-value]',
      '.vvp-item-tax-value', '.vvp-item-tax-string',
      '.vvp-item-price', '.vvp-item-price-string'
    ];
    for (const sel of selectors) {
      const el = tile.querySelector(sel);
      if (el?.textContent) {
        const m = el.textContent.match(/\$?([\d,]+\.?\d*)/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
      }
    }

    // Text-scan fallback
    const text = Array.from(tile.querySelectorAll('span, div, p, strong'))
      .map(el => el.textContent.trim()).filter(Boolean).join(' ');
    const m = text.match(/(?:ETV|Estimated Taxable Value|Tax Value)[:\s]*\$?([\d,]+\.?\d*)/i);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  function enhanceTile(tile, product) {
    tile.querySelectorAll('.ve-badge, .ve-keyword-tag').forEach(el => el.remove());
    const container = tile.querySelector('.vvp-item-tile-content') || tile;

    if (product.etv !== null) {
      const badge = document.createElement('div');
      badge.className   = 've-badge ve-etv-badge';
      badge.textContent = `ETV: $${product.etv.toFixed(2)}`;
      container.appendChild(badge);
    }

    if (product.limitedQuantity) {
      const badge = document.createElement('div');
      badge.className   = 've-badge ve-limited-badge';
      badge.textContent = '\uD83D\uDE80 Limited';
      container.appendChild(badge);
    }

    if (product.hasOptions) {
      const badge = document.createElement('div');
      badge.className   = 've-badge ve-options-badge';
      badge.textContent = 'Has Options';
      container.appendChild(badge);
    }

    if (product.keywordsMatched?.length > 0) {
      tile.classList.add('ve-keyword-match');
      const tag = document.createElement('div');
      tag.className   = 've-keyword-tag';
      tag.textContent = `\uD83D\uDD0D ${product.keywordsMatched.join(', ')}`;
      container.appendChild(tag);
    }

    if (product.available === false) tile.classList.add('ve-unavailable');
  }

  // ── Find tile by ASIN ──────────────────────────────────────────────────────
  function findTileByAsin(asin) {
    let tile = document.querySelector(`.vvp-item-tile[data-asin="${asin}"]`);
    if (tile) return tile;

    const btn = document.querySelector(`input[data-asin="${asin}"]`);
    if (btn) return btn.closest('.vvp-item-tile');

    // Most reliable on Vine: find via product link href
    const link = document.querySelector(`.vvp-item-tile a[href*="/dp/${asin}"]`);
    if (link) return link.closest('.vvp-item-tile');

    console.warn('[VineExplorer] Could not find tile for ASIN:', asin);
    return null;
  }

  // ── Auto-fetch queue ───────────────────────────────────────────────────────
  // ETV is fetched by calling the Vine recommendations API directly.
  // Correct endpoint (from network traces):
  //   Simple product:  GET /vine/api/recommendations/{recId}/item/{asin}?imageSize=180
  //   Variation list:  GET /vine/api/recommendations/{recId}
  // Both return JSON: { result: { taxValue, variations, ... }, error }

  function enqueueForFetch(tile, asin) {
    const input = tile.querySelector('input[data-recommendation-id]');
    const recommendationId = input?.getAttribute('data-recommendation-id');
    if (recommendationId) fetchQueue.push({ tile, asin, recommendationId });
  }

  async function fetchEtvFromApi(recommendationId, asin) {
    console.log(`[VineExplorer] Fetching ETV from API for ASIN: ${asin}  RecID: ${recommendationId}`);
    try {
      // Try fetching the specific item detail directly (works for simple products
      // and for individual variation items).
      const detailUrl =
        `/vine/api/recommendations/${encodeURIComponent(recommendationId)}/item/${asin}?imageSize=180`;
      const res = await fetch(detailUrl, { credentials: 'include' });
      if (!res.ok) {
        console.warn('[VineExplorer] API', res.status, 'for', asin);
        return { etv: null };
      }
      const json = await res.json();
      const result = json?.result;
      console.log('[VineExplorer] API response for item detail:', result);
      console.log('[VineExplorer] DetailURL:', detailUrl);
      //if (!result) return { etv: null };
      console.log('[VineExplorer] API result for item detail was not null:', result);
      console.log('[VineExplorer] Checking taxValue for:', asin, '→', result.taxValue);
      if (result.taxValue !== null && result.taxValue !== undefined) {
        return {
          etv:                   result.taxValue,
          hasOptions:            false,
          productSiteLaunchDate: result.productSiteLaunchDate ?? null,
          limitedQuantity:       result.limitedQuantity === true,
        };
      }

      // taxValue absent on parent products — fetch the variations list and
      // recurse with the first child's recommendationId + asin.
      console.log('[VineExplorer] Fetching variations for:', asin);
      const varUrl = `/vine/api/recommendations/${encodeURIComponent(recommendationId)}`;
      const varRes = await fetch(varUrl, { credentials: 'include' });
      if (!varRes.ok) return { etv: null, hasOptions: false };

      const varJson  = await varRes.json();
      const firstVar = varJson?.result?.variations?.[0];
      if (firstVar?.recommendationId && firstVar?.asin) {
        console.log('[VineExplorer] Fetching first variation for:', asin, '→', firstVar.asin);
        await sleep(randomBetween(1500, 4000));
        // Recursive call to fetch the first variation's details, which should include ETV.
        const child = await fetchEtvFromApi(firstVar.recommendationId, firstVar.asin);
        return { ...child, hasOptions: true };
      }

      // No taxValue and no variations with their own recommendationId → treat as no ETV but has options.
      console.log('[VineExplorer] No ETV and no child variations for:', asin);
      console.log('[VineExplorer] Response was:', varJson);
      console.log('[VineExplorer] Response Value was:', result);
      return { etv: null, hasOptions: !!varJson?.result?.variations?.length };
    } catch (e) {
      console.error('[VineExplorer] ETV fetch error:', e);
      return { etv: null };
    }
  }

  async function runFetchQueue() {
    if (isFetching) return;

    if (fetchQueue.length === 0) {
      await goToNextPage();
      return;
    }

    isFetching = true;
    console.log(`[VineExplorer] Fetching ETVs via API: ${fetchQueue.length} queued`);

    while (fetchQueue.length > 0) {
      const { tile, asin, recommendationId } = fetchQueue.shift();
      setStatus(`Fetching ETV… ${fetchQueue.length + 1} remaining`);

      const { etv, hasOptions, productSiteLaunchDate, limitedQuantity } = await fetchEtvFromApi(recommendationId, asin);
      console.log(`[VineExplorer] API fetch → ${asin}: ETV=${etv}  hasOptions=${hasOptions}  limited=${limitedQuantity}  launchDate=${productSiteLaunchDate}`);

      const update = { asin, available: true };
      if (etv                   !== null)      update.etv                   = etv;
      if (hasOptions            !== undefined) update.hasOptions            = hasOptions;
      if (productSiteLaunchDate !== null)      update.productSiteLaunchDate = productSiteLaunchDate;
      if (limitedQuantity       === true)      update.limitedQuantity       = true;

      const res = await send({ type: 'SAVE_PRODUCT', product: update });
      if (res?.product) {
        processedAsins.delete(asin);
        enhanceTile(tile, res.product);
        processedAsins.add(asin);
      }

      await sleep(randomBetween(3000, 8000));
    }

    isFetching = false;
    await updateStatusCount();
    await sleep(randomBetween(8000, 15000));
    await goToNextPage();
  }

  async function goToNextPage() {
    const nextBtn = document.querySelector(
      'ul.a-pagination .a-last:not(.a-disabled) a, ' +
      'ul.a-pagination li.a-last a'
    );
    if (!nextBtn) {
      console.log('[VineExplorer] No next page — all done.');
      setStatus('Vine Explorer — all pages fetched ✓');
      return;
    }
    console.log('[VineExplorer] Navigating to next page…');
    setStatus('Vine Explorer — loading next page…');
    nextBtn.click();
  }

  // ── Detail panel scraping ──────────────────────────────────────────────────
  // The modal already exists in DOM and is toggled via style.display.

  function watchDetailPanel() {
    function observeModal(modal) {
      let lastDisplay = modal.style.display;
      const obs = new MutationObserver(() => {
        const cur = modal.style.display;
        if (cur !== 'none' && cur !== '' && lastDisplay !== cur) {
          setTimeout(() => extractFromDetailPanel(modal), 500);
        }
        lastDisplay = cur;
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['style'] });
    }

    const modal = document.getElementById('vvp-product-details-modal--main');
    if (modal) {
      observeModal(modal);
    } else {
      const waiter = new MutationObserver(() => {
        const m = document.getElementById('vvp-product-details-modal--main');
        if (m) { waiter.disconnect(); observeModal(m); }
      });
      waiter.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function extractFromDetailPanel(panel) {
    const titleLink = panel.querySelector('#vvp-product-details-modal--product-title');
    if (!titleLink) { console.warn('[VineExplorer] No title link in panel'); return; }

    const asinMatch = (titleLink.getAttribute('href') || '').match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) return;
    const asin = asinMatch[1];

    let etv = null;
    const etvEl = panel.querySelector('#vvp-product-details-modal--tax-value-string');
    if (etvEl) {
      const m = etvEl.textContent.match(/\$?([\d,]+\.?\d*)/);
      if (m) etv = parseFloat(m[1].replace(',', ''));
    }

    const descEl    = panel.querySelector('#vvp-product-details-modal--feature-bullets');
    const vendorEl  = panel.querySelector('#vvp-product-details-modal--by-line');
    const hasOptions = !!panel.querySelector('#vvp-product-details-modal--variations-container select');

    const product = {
      asin,
      etv,
      description: descEl?.outerHTML?.trim() || '',
      vendor:      (vendorEl?.textContent || '').replace(/^by\s+/i, '').trim(),
      hasOptions,
      title:       titleLink.textContent?.trim() || undefined,
      available:   true
    };

    console.log(`[VineExplorer] Scraped: ${asin}  ETV=${etv}  options=${hasOptions}`);

    const res   = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    if (saved) {
      const tile = findTileByAsin(asin);
      if (tile) {
        processedAsins.delete(asin);
        enhanceTile(tile, saved);
        processedAsins.add(asin);
      }
    }

    updateStatusCount();
  }

  // ── MutationObserver for infinite scroll ──────────────────────────────────
  function observePageChanges() {
    const grid = document.querySelector('#vvp-items-grid, .vvp-items-grid, main');
    if (!grid) return;
    const obs = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('vvp-item-tile')) {
            processTile(node);
          } else {
            node.querySelectorAll?.('.vvp-item-tile').forEach(processTile);
          }
        }
      }
    });
    obs.observe(grid, { childList: true, subtree: true });
  }

  // ── Message listener ───────────────────────────────────────────────────────
  function listenForRescrape() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'REQUEST_RESCRAPE') {
        processedAsins.clear();
        fetchQueue = [];
        isFetching = false;
        processAllTiles().then(() => setTimeout(runFetchQueue, 1000));
      } else if (msg.type === 'GET_PAGINATION_INFO') {
        sendResponse(extractPagination());
      }
      return true;
    });
  }

  // ── Pagination info ────────────────────────────────────────────────────────
  function extractPagination() {
    const pag = document.querySelector('.a-pagination');
    if (!pag) return { current: 1, total: 1 };

    let maxPage = 1;
    pag.querySelectorAll('a').forEach(a => {
      const m = a.href.match(/[?&]page=(\d+)/);
      if (m) maxPage = Math.max(maxPage, +m[1]);
    });

    const current = +(new URLSearchParams(window.location.search).get('page')) || 1;
    return { current, total: maxPage };
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Retries if the MV3 service worker isn't awake yet.
  function send(msg, retries = 4, delayMs = 300) {
    return new Promise((resolve) => {
      function attempt(remaining) {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            const isConnErr = err.message?.includes('Receiving end does not exist') ||
                              err.message?.includes('Could not establish connection');
            if (remaining > 0 && isConnErr) {
              console.warn(`[VineExplorer] SW not ready, retrying (${remaining} left)…`);
              setTimeout(() => attempt(remaining - 1), delayMs);
            } else {
              console.error('[VineExplorer] Message failed:', err.message);
              resolve({});
            }
          } else {
            resolve(res ?? {});
          }
        });
      }
      attempt(retries);
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
