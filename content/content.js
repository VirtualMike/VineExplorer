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
    setTimeout(runFetchQueue, 1500);
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
      if (saved.etv === null) enqueueForFetch(tile);
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
  function enqueueForFetch(tile) {
    const btn = tile.querySelector('input.a-button-input[type="submit"], input.a-button-input');
    if (btn) fetchQueue.push({ tile, btn });
  }

  async function runFetchQueue() {
    if (isFetching) return;

    if (fetchQueue.length === 0) {
      await goToNextPage();
      return;
    }

    isFetching = true;
    console.log(`[VineExplorer] Auto-fetch: ${fetchQueue.length} tiles queued`);

    while (fetchQueue.length > 0) {
      const { tile, btn } = fetchQueue.shift();
      setStatus(`Auto-fetching ETV… ${fetchQueue.length + 1} remaining`);

      tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(randomBetween(500, 900));

      btn.click();
      await waitForEtv();
      await closeModal();

      await sleep(randomBetween(2000, 4000));
    }

    isFetching = false;
    await updateStatusCount();
    await sleep(randomBetween(2000, 3000));
    await goToNextPage();
  }

  async function waitForEtv(maxWait = 8000) {
    const interval = 200;
    let waited = 0;
    while (waited < maxWait) {
      const modal   = document.getElementById('vvp-product-details-modal--main');
      const spinner = document.getElementById('vvp-product-details-modal--tax-spinner');
      const etvEl   = document.getElementById('vvp-product-details-modal--tax-value-string');

      const modalOpen   = modal && modal.style.display !== 'none' && modal.style.display !== '';
      const spinnerDone = !spinner || spinner.style.display === 'none';
      const etvReady    = etvEl && etvEl.textContent.trim().length > 0;

      if (modalOpen && spinnerDone && etvReady) return;

      await sleep(interval);
      waited += interval;
    }
    console.warn('[VineExplorer] waitForEtv timed out');
  }

  async function closeModal() {
    const modal = document.getElementById('vvp-product-details-modal--main');
    if (!modal || modal.style.display === 'none' || modal.style.display === '') return;

    // 1. Dedicated close button
    const closeBtn = document.querySelector(
      '#vvp-product-details-modal .a-icon-close, ' +
      '[data-action="a-modal-close"], ' +
      '.vvp-modal-close, ' +
      'button[aria-label*="close" i], button[title*="close" i]'
    );
    if (closeBtn) { closeBtn.click(); await sleep(400); return; }

    // 2. Click overlay (parent of modal content)
    if (modal.parentElement) { modal.parentElement.click(); await sleep(400); }

    // 3. Escape key fallback
    if (modal.style.display !== 'none' && modal.style.display !== '') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(400);
    }
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
