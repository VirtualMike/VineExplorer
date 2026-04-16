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
    const page = new URLSearchParams(window.location.search).get('page') || '1';
    console.log(`[VineExplorer] ═══ INIT page ${page} ═══ ${window.location.href}`);
    await loadKeywords();
    injectStatusBar();
    await processAllTiles();   // wait so fetchQueue is fully populated
    console.log(`[VineExplorer] Tiles processed. ${fetchQueue.length} queued for ETV fetch, ${processedAsins.size} ASINs seen.`);
    observePageChanges();
    listenForRescrape();
    updateStatusCount();
    // Start auto-fetch after page settles
    console.log('[VineExplorer] Waiting 3s before starting ETV fetch queue…');
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

  async function runFetchQueue() {
    if (isFetching) {
      console.log('[VineExplorer] runFetchQueue called but already fetching — skipping');
      return;
    }

    if (fetchQueue.length === 0) {
      console.log('[VineExplorer] Fetch queue empty — proceeding to next page');
      await goToNextPage();
      return;
    }

    isFetching = true;
    const total = fetchQueue.length;
    console.log(`[VineExplorer] ─── ETV FETCH START ─── ${total} items queued`);

    let fetched = 0;
    while (fetchQueue.length > 0) {
      const { tile, asin, recommendationId } = fetchQueue.shift();
      fetched++;
      setStatus(`Fetching ETV… ${fetchQueue.length + 1} remaining`);
      console.log(`[VineExplorer] [${fetched}/${total}] Fetching ${asin}…`);

      const { etv, hasOptions, productSiteLaunchDate, limitedQuantity,
              title, description, vendor, imageUrl } = await fetchEtvFromApi(recommendationId, asin);
      console.log(`[VineExplorer] [${fetched}/${total}] ${asin}: ETV=${etv}  options=${hasOptions}  limited=${limitedQuantity}  vendor=${vendor ? vendor.slice(0,30) : '—'}  desc=${description ? 'yes' : 'no'}`);

      const update = { asin, available: true };
      if (etv                   !== null)      update.etv                   = etv;
      if (hasOptions            !== undefined) update.hasOptions            = hasOptions;
      if (productSiteLaunchDate !== null)      update.productSiteLaunchDate = productSiteLaunchDate;
      if (limitedQuantity       === true)      update.limitedQuantity       = true;
      if (title)                               update.title                 = title;
      if (description)                         update.description           = description;
      if (vendor)                              update.vendor                = vendor;
      if (imageUrl)                            update.imageUrl              = imageUrl;

      const res = await send({ type: 'SAVE_PRODUCT', product: update });
      if (res?.product) {
        processedAsins.delete(asin);
        enhanceTile(tile, res.product);
        processedAsins.add(asin);
      } else {
        console.warn(`[VineExplorer] [${fetched}/${total}] SAVE_PRODUCT failed for ${asin}:`, res);
      }

      await sleep(randomBetween(3000, 8000));
    }

    isFetching = false;
    await updateStatusCount();
    console.log(`[VineExplorer] ─── ETV FETCH DONE ─── ${fetched} items processed`);
    console.log('[VineExplorer] Pausing 60s before next page (download logs now)…');
    setStatus('Vine Explorer — page done, next page in ~60s…');
    await sleep(60_000);
    await goToNextPage();
  }

  async function goToNextPage() {
    const { current, total } = extractPagination();
    const nextBtn = document.querySelector(
      'ul.a-pagination .a-last:not(.a-disabled) a, ' +
      'ul.a-pagination li.a-last a'
    );
    if (!nextBtn) {
      console.log(`[VineExplorer] ═══ ALL DONE ═══ Finished on page ${current}/${total}`);
      setStatus('Vine Explorer — all pages fetched ✓');
      return;
    }
    console.log(`[VineExplorer] ═══ NAVIGATE ═══ page ${current} → ${current + 1} of ${total}`);
    setStatus(`Vine Explorer — loading page ${current + 1}/${total}…`);
    nextBtn.click();
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
