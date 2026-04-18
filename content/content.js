// content/content.js — Vine Explorer content script
// Runs on: https://www.amazon.com/vine/*
// NOTE: All DB access goes through chrome.runtime.sendMessage to the service worker.

(function VineExplorer() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let keywords             = [];
  let statusBar            = null;
  let processedAsins       = new Set();
  let fetchQueue           = [];      // current-page ETV queue (tiles with DOM refs)
  let isFetching           = false;
  let isBackgroundScanning = false;
  let scanAborted          = false;

  // Shared queue for background ETV scanning — sorted by productSiteLaunchDate (newest first)
  let etvQueue     = [];
  let pageScanDone = false;

  // Scan delay settings (loaded from chrome.storage.local)
  let scanSettings = {
    PageBackgroundScanDelay:      3000,
    PageBackgroundScanRandomness: 5000,
    ETVBackgroundScanDelay:       3000,
    ETVBackgroundScanRandomness:  5000
  };

  const isVineItemsPage = window.location.pathname.startsWith('/vine/vine-items');

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    console.log(`[VineExplorer] ═══ INIT ═══ ${window.location.href}`);
    await loadKeywords();
    await loadSettings();
    injectStatusBar();
    listenForMessages();

    if (isVineItemsPage) {
      await processAllTiles();
      console.log(`[VineExplorer] Tiles processed. ${fetchQueue.length} queued for ETV fetch, ${processedAsins.size} ASINs seen.`);
      observePageChanges();
    }

    updateStatusCount();

    window.addEventListener('beforeunload', () => { scanAborted = true; });

    // Start: process current page ETVs then background scan
    setTimeout(async () => {
      if (isVineItemsPage && fetchQueue.length > 0) {
        await runFetchQueueForCurrentPage();
      }
      await startBackgroundScan();
    }, 3000);
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(scanSettings);
      Object.assign(scanSettings, stored);
      console.log('[VineExplorer] Scan settings:', scanSettings);
    } catch { /* use defaults */ }
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

    const res   = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    if (saved) {
      enhanceTile(tile, saved);
      if (saved.etv === null) {
        enqueueForFetch(tile, asin);
      } else {
        console.log(`[VineExplorer] Tile ${asin}: already has ETV=$${saved.etv} — skipping fetch`);
      }
    } else {
      console.warn(`[VineExplorer] Tile ${asin}: SAVE_PRODUCT returned no product`, res);
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
      console.debug('[VineExplorer] API response for item detail:', result);
      console.debug('[VineExplorer] DetailURL:', detailUrl);
      if (!result) {
        // ITEM_NOT_IN_ENROLLMENT means the recommendationId is a parent bundle —
        // fall through to the variations endpoint to find a valid child item.
        if (json?.error?.exceptionType !== 'ITEM_NOT_IN_ENROLLMENT') return { etv: null };
        console.log('[VineExplorer] ITEM_NOT_IN_ENROLLMENT for', asin, '— trying variations');
      } else if (result.taxValue !== null && result.taxValue !== undefined) {
        const bullets = result.featureBullets;
        return {
          etv:                   result.taxValue,
          hasOptions:            false,
          productSiteLaunchDate: result.productSiteLaunchDate ?? null,
          limitedQuantity:       result.limitedQuantity === true,
          title:                 result.productTitle || null,
          description:           bullets?.length
                                   ? '<ul>' + bullets.map(b =>
                                       `<li>${b.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</li>`
                                     ).join('') + '</ul>'
                                   : null,
          vendor:                result.byLineContributors?.join(', ') || null,
          imageUrl:              result.imageUrl || null,
        };
      }

      // taxValue absent OR ITEM_NOT_IN_ENROLLMENT — fetch the variations list and
      // recurse with the first child's recommendationId + asin.
      console.log('[VineExplorer] Fetching variations for:', asin);
      const varUrl = `/vine/api/recommendations/${encodeURIComponent(recommendationId)}`;
      const varRes = await fetch(varUrl, { credentials: 'include' });
      if (!varRes.ok) return { etv: null, hasOptions: false };

      const varJson  = await varRes.json();
      const firstVar = varJson?.result?.variations?.[0];
      if (varJson?.result?.recommendationId && firstVar?.asin) {
        console.log('[VineExplorer] Fetching first variation for:', asin, '→', firstVar.asin);
        await sleep(randomBetween(1500, 4000));
        // Recursive call to fetch the first variation's details, which should include ETV.
        const child = await fetchEtvFromApi(varJson.result.recommendationId, firstVar.asin);
        return { ...child, hasOptions: true };
      }

      // No taxValue and no variations with their own recommendationId → treat as no ETV but has options.
      console.debug('[VineExplorer] No ETV and no child variations for:', asin);
      console.debug('[VineExplorer] Response was:', varJson);
      console.debug('[VineExplorer] Response Value was:', result);
      return { etv: null, hasOptions: !!varJson?.result?.variations?.length };
    } catch (e) {
      console.error('[VineExplorer] ETV fetch error:', e);
      return { etv: null };
    }
  }

  // Fetches ETVs for tiles on the current visible page only (no navigation).
  async function runFetchQueueForCurrentPage() {
    if (isFetching || fetchQueue.length === 0) return;

    isFetching = true;
    const total = fetchQueue.length;
    console.log(`[VineExplorer] ─── ETV FETCH (current page) ─── ${total} items queued`);

    let fetched = 0;
    while (fetchQueue.length > 0) {
      const { tile, asin, recommendationId } = fetchQueue.shift();
      fetched++;
      setStatus(`Fetching ETV… ${fetchQueue.length + 1} remaining`);

      const apiResult = await fetchEtvFromApi(recommendationId, asin);
      const update = buildUpdateFromApi(asin, apiResult);
      console.log(`[VineExplorer] [${fetched}/${total}] ${asin}: ETV=${apiResult.etv}  vendor=${apiResult.vendor ? apiResult.vendor.slice(0,30) : '—'}  desc=${apiResult.description ? 'yes' : 'no'}`);

      const res = await send({ type: 'SAVE_PRODUCT', product: update });
      if (res?.product) {
        enhanceTile(tile, res.product);
      }

      await sleep(randomBetween(3000, 8000));
    }

    isFetching = false;
    await updateStatusCount();
    console.log(`[VineExplorer] ─── ETV FETCH DONE ─── ${fetched} items processed`);
  }

  // Builds a SAVE_PRODUCT update object from API result fields.
  function buildUpdateFromApi(asin, apiResult) {
    const { etv, hasOptions, productSiteLaunchDate, limitedQuantity,
            title, description, vendor, imageUrl } = apiResult;
    const update = { asin, available: true };
    if (etv                   !== null      && etv !== undefined)        update.etv                   = etv;
    if (hasOptions            !== undefined)                             update.hasOptions            = hasOptions;
    if (productSiteLaunchDate !== null      && productSiteLaunchDate !== undefined) update.productSiteLaunchDate = productSiteLaunchDate;
    if (limitedQuantity       === true)                                  update.limitedQuantity       = true;
    if (title)                                                           update.title                 = title;
    if (description)                                                     update.description           = description;
    if (vendor)                                                          update.vendor                = vendor;
    if (imageUrl)                                                        update.imageUrl              = imageUrl;
    return update;
  }

  // ── Background scanning ────────────────────────────────────────────────────
  // Fetches catalog pages via fetch() without navigating the tab, parses HTML
  // with DOMParser, and calls the item detail API for ETV/description/vendor.

  async function fetchPageHtml(queue, page) {
    const url = `/vine/vine-items?queue=${encodeURIComponent(queue)}&page=${page}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    // Detect session expiry (redirect to login page)
    if (res.url.includes('/ap/signin')) throw new Error('Session expired');
    return res.text();
  }

  function parsePageProducts(html) {
    const doc   = new DOMParser().parseFromString(html, 'text/html');
    const tiles = doc.querySelectorAll('.vvp-item-tile');
    const products = [];

    for (const tile of tiles) {
      const asin = extractAsin(tile);
      if (!asin) continue;

      const input = tile.querySelector('input[data-recommendation-id]');
      const recommendationId = input?.getAttribute('data-recommendation-id');
      if (!recommendationId) continue;

      const product = extractProductFromTile(tile, asin);
      if (product) {
        products.push({ ...product, recommendationId });
      }
    }

    // Extract pagination from the parsed HTML
    const pag = doc.querySelector('.a-pagination');
    let totalPages = 1;
    if (pag) {
      pag.querySelectorAll('a').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
        if (m) totalPages = Math.max(totalPages, +m[1]);
      });
    }

    return { products, totalPages };
  }

  // ── Orchestrator ─────────────────────────────────────────────────────────
  async function startBackgroundScan() {
    const claim = await send({ type: 'CLAIM_SCAN_LOCK' });
    if (!claim.granted) {
      console.log('[VineExplorer] Another tab is scanning — skipping background scan');
      setStatus('Vine Explorer — another tab is scanning');
      return;
    }

    isBackgroundScanning = true;
    scanAborted  = false;
    pageScanDone = false;
    etvQueue     = [];
    console.log('[VineExplorer] ═══ BACKGROUND SCAN START ═══');

    try {
      // Run page scanner and ETV scanner concurrently
      await Promise.all([
        pageScannerLoop(claim.state || {}),
        etvScannerLoop()
      ]);
    } finally {
      isBackgroundScanning = false;
      await send({ type: 'RELEASE_SCAN_LOCK' });
      if (!scanAborted) {
        await send({ type: 'RESET_SCAN_STATE' });
        await updateStatusCount();
        const stats = await send({ type: 'GET_STATS' });
        console.log(`[VineExplorer] ═══ BACKGROUND SCAN COMPLETE ═══ ${stats.total || 0} products cataloged`);
        setStatus(`Vine Explorer — scan complete, ${stats.total || 0} products`);
      } else {
        console.log('[VineExplorer] ═══ BACKGROUND SCAN ABORTED (page unload) ═══');
      }
    }
  }

  // ── Page Scanner ───────────────────────────────────────────────────────────
  // Fast loop: fetches catalog pages, saves basic product data, pushes items
  // needing ETV into the shared etvQueue for the ETV scanner.

  async function pageScannerLoop(state) {
    const queues          = ['potluck', 'encore', 'last_chance'];
    const completedQueues = new Set(state.completedQueues || []);

    try {
      for (const queue of queues) {
        if (scanAborted) break;
        if (completedQueues.has(queue)) {
          console.log(`[VineExplorer] [PageScan] Queue "${queue}" already completed — skipping`);
          continue;
        }

        let page = (state.currentQueue === queue && state.currentPage > 1)
          ? state.currentPage
          : 1;
        let totalPages = state.totalPages || null;

        console.log(`[VineExplorer] [PageScan] ─── Queue: ${queue} (starting page ${page}) ───`);

        while (!scanAborted) {
          setStatus(`Scanning ${queue} page ${page}${totalPages ? '/' + totalPages : ''}… (${etvQueue.length} ETV queued)`);

          let parsed;
          try {
            const html = await fetchPageHtml(queue, page);
            parsed = parsePageProducts(html);
          } catch (err) {
            console.error(`[VineExplorer] [PageScan] Failed ${queue} p${page}:`, err.message);
            await sleep(10_000);
            try {
              const html = await fetchPageHtml(queue, page);
              parsed = parsePageProducts(html);
            } catch (retryErr) {
              console.error(`[VineExplorer] [PageScan] Retry failed ${queue} p${page}:`, retryErr.message);
              break;
            }
          }

          totalPages = parsed.totalPages;
          console.log(`[VineExplorer] [PageScan] ${queue} p${page}/${totalPages}: ${parsed.products.length} products`);

          // Save basic product data and push items needing ETV to the shared queue
          for (const p of parsed.products) {
            if (scanAborted) break;
            const productData = { ...p, category: queue };
            if (queue === 'encore') productData.encorePageFirstSeen = page;

            const saveRes = await send({ type: 'SAVE_PRODUCT', product: productData });
            const saved   = saveRes?.product;

            if (saved && (saved.etv === null || saved.etv === undefined)) {
              // Push to ETV queue with the launch date for sorting
              etvQueue.push({
                asin:                  p.asin,
                recommendationId:      p.recommendationId,
                category:              queue,
                productSiteLaunchDate: saved.productSiteLaunchDate ?? null
              });
            }
          }

          // Checkpoint progress
          await send({ type: 'UPDATE_SCAN_STATE', patch: {
            currentQueue: queue,
            currentPage:  page + 1,
            totalPages
          }});

          if (page >= totalPages) break;
          page++;

          const delay = scanSettings.PageBackgroundScanDelay
                      + randomBetween(0, scanSettings.PageBackgroundScanRandomness);
          await sleep(delay);
        }

        completedQueues.add(queue);
        await send({ type: 'UPDATE_SCAN_STATE', patch: {
          completedQueues: [...completedQueues]
        }});
        console.log(`[VineExplorer] [PageScan] ─── Queue "${queue}" done ───`);

        if (!scanAborted && queue !== queues[queues.length - 1]) {
          await sleep(randomBetween(10_000, 25_000));
        }
      }
    } finally {
      pageScanDone = true;
      console.log(`[VineExplorer] [PageScan] Finished. ${etvQueue.length} items still in ETV queue.`);
    }
  }

  // ── ETV Scanner ────────────────────────────────────────────────────────────
  // Runs concurrently with the page scanner. Pulls from the shared etvQueue,
  // always processing the newest item first (sorted by productSiteLaunchDate).

  async function etvScannerLoop() {
    console.log('[VineExplorer] [ETVScan] Started — waiting for items…');

    while (!scanAborted) {
      // Wait for items or for the page scanner to finish
      if (etvQueue.length === 0) {
        if (pageScanDone) break; // nothing left to process
        await sleep(2000);       // short poll — page scanner is still adding items
        continue;
      }

      // Sort: newest productSiteLaunchDate first, nulls last
      etvQueue.sort((a, b) => {
        if (a.productSiteLaunchDate == null && b.productSiteLaunchDate == null) return 0;
        if (a.productSiteLaunchDate == null) return 1;
        if (b.productSiteLaunchDate == null) return -1;
        return b.productSiteLaunchDate - a.productSiteLaunchDate;
      });

      const item = etvQueue.shift();
      setStatus(`ETV: ${etvQueue.length + 1} remaining…`);
      console.log(`[VineExplorer] [ETVScan] Fetching ${item.asin} (queue left: ${etvQueue.length})`);

      const apiResult = await fetchEtvFromApi(item.recommendationId, item.asin);
      const update    = buildUpdateFromApi(item.asin, apiResult);
      update.category = item.category;
      await send({ type: 'SAVE_PRODUCT', product: update });

      const delay = scanSettings.ETVBackgroundScanDelay
                  + randomBetween(0, scanSettings.ETVBackgroundScanRandomness);
      await sleep(delay);
    }

    console.log('[VineExplorer] [ETVScan] Done.');
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
  function listenForMessages() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'REQUEST_RESCRAPE' && isVineItemsPage) {
        processedAsins.clear();
        fetchQueue = [];
        isFetching = false;
        processAllTiles().then(() => setTimeout(runFetchQueueForCurrentPage, 1000));
      } else if (msg.type === 'GET_PAGINATION_INFO') {
        sendResponse(extractPagination());
      } else if (msg.type === 'START_BACKGROUND_SCAN') {
        if (!isBackgroundScanning) {
          startBackgroundScan();
        }
        sendResponse({ ok: true });
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
