// content/content.js — Vine Explorer content script
// Runs on: https://www.amazon.com/vine/vine-items*
// NOTE: This script runs in a sandboxed content-script world.
//       All DB access goes through chrome.runtime.sendMessage to the service worker.

(function VineExplorer() {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let keywords       = [];
  let statusBar      = null;
  let processedAsins = new Set();
  let detailFetchQueue = [];
  let detailFetchRunning = false;

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    console.log('[VineExplorer] Initializing…');
    await loadKeywords();
    console.log('[VineExplorer] Keywords loaded:', keywords);
    injectStatusBar();
    processAllTiles();
    observePageChanges();
    watchDetailPanel();
    listenForRescrape();
    updateStatusCount();
  }

  // ── Load keywords from service worker ─────────────────────────────────────
  async function loadKeywords() {
    const res = await send({ type: 'GET_KEYWORDS' });
    keywords  = (res.keywords || []).map(k => k.keyword);
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

  async function updateStatusCount() {
    const res = await send({ type: 'GET_STATS' });
    if (statusBar && res) {
      const el = document.getElementById('ve-status-text');
      if (el) el.textContent = `Vine Explorer — ${res.available} products cached`;
    }
  }

  // ── Tile processing ────────────────────────────────────────────────────────
  function processAllTiles() {
    const tiles = document.querySelectorAll('.vvp-item-tile');
    console.log(`[VineExplorer] Found ${tiles.length} tiles`);
    tiles.forEach(processTile);
  }

  async function processTile(tile) {
    const asin = extractAsin(tile);
    console.log('[VineExplorer] Tile ASIN:', asin);
    if (!asin || processedAsins.has(asin)) return;
    processedAsins.add(asin);

    const product = extractProductFromTile(tile, asin);
    if (!product) return;

    const etvFromTile = extractEtvFromTile(tile);
    if (etvFromTile !== null) {
      product.etv = etvFromTile;
    }

    // Save to DB (SW will check keyword matches)
    const res = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    // Enhance the tile with cached data
    if (saved) {
      enhanceTile(tile, saved);
    }

    if (saved?.etv == null) {
      scheduleDetailFetch(tile, asin);
    }
  }

  function extractAsin(tile) {
    // Try various locations Amazon puts the ASIN
    const btn = tile.querySelector('input[data-recommendation-id], input[data-asin]');
    if (btn) {
      const recId = btn.getAttribute('data-recommendation-id') || '';
      const asinFromRec = recId.split('|').find(p => /^[A-Z0-9]{10}$/.test(p));
      if (asinFromRec) return asinFromRec;
      const direct = btn.getAttribute('data-asin');
      if (direct) return direct;
    }

    // Try data attributes on the tile itself
    const tileAsin = tile.getAttribute('data-asin');
    if (tileAsin) return tileAsin;

    // Try the product link URL
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
    const title = titleEl?.textContent?.trim() || '';
    const imageUrl = imgEl?.src || imgEl?.getAttribute('data-src') || '';

    if (!asin) return null;

    return { asin, title, imageUrl, available: true };
  }

  function extractEtvFromTile(tile) {
    if (!tile) return null;

    const selectors = [
      '[data-etv]',
      '[data-tax-value]',
      '.vvp-item-tax-value',
      '.vvp-item-tax-string',
      '.vvp-item-price',
      '.vvp-item-price-string'
    ];

    for (const selector of selectors) {
      const el = tile.querySelector(selector);
      if (el?.textContent) {
        const match = el.textContent.match(/\$?([\d,]+\.?\d*)/);
        if (match) return parseFloat(match[1].replace(/,/g, ''));
      }
    }

    const text = Array.from(tile.querySelectorAll('span, div, p, strong'))
      .map(el => el.textContent.trim())
      .filter(Boolean)
      .join(' ');

    const match = text.match(/(?:ETV|Estimated Taxable Value|Tax Value|Taxable Value)[:\s]*\$?([\d,]+\.?\d*)/i);
    if (match) return parseFloat(match[1].replace(/,/g, ''));

    return null;
  }

  function scheduleDetailFetch(tile, asin) {
    if (!tile || !asin) return;
    if (tile.dataset.veEtvFetchScheduled === '1') return;
    tile.dataset.veEtvFetchScheduled = '1';
    detailFetchQueue.push({ tile, asin });
    processDetailFetchQueue();
  }

  async function processDetailFetchQueue() {
    if (detailFetchRunning) return;
    detailFetchRunning = true;

    while (detailFetchQueue.length > 0) {
      const { tile, asin } = detailFetchQueue.shift();
      if (!document.contains(tile)) continue;
      await fetchDetailPanelForTile(tile, asin);
      await sleep(randomBetween(1200, 2200));
    }

    detailFetchRunning = false;
  }

  async function fetchDetailPanelForTile(tile, asin) {
    const trigger = findDetailToggle(tile);
    if (!trigger) return;

    const modalReady = waitForDetailModalOpen(7000);
    trigger.click();
    await modalReady.catch(() => null);
    await sleep(1000);
    closeDetailPanel();
  }

  function findDetailToggle(tile) {
    if (!tile) return null;

    const candidates = Array.from(tile.querySelectorAll('button, a, [role="button"]'));
    const matchText = /detail|details|see details|product details/i;

    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const label = (el.getAttribute('aria-label') || '').trim();
      if (matchText.test(text) || matchText.test(label)) {
        return el;
      }
    }

    return null;
  }

  function waitForDetailModalOpen(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const modal = document.getElementById('vvp-product-details-modal--main');
      const start = Date.now();

      function checkOpen(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      }

      if (checkOpen(modal)) {
        resolve(modal);
        return;
      }

      const observer = new MutationObserver(() => {
        const currentModal = document.getElementById('vvp-product-details-modal--main');
        if (checkOpen(currentModal)) {
          observer.disconnect();
          resolve(currentModal);
        } else if (Date.now() - start > timeoutMs) {
          observer.disconnect();
          reject(new Error('Detail modal did not open in time'));
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    });
  }

  function closeDetailPanel() {
    const modal = document.getElementById('vvp-product-details-modal--main');
    if (!modal) return;

    const closeButton = modal.querySelector('button[aria-label*="close"], button[title*="Close"], .a-button-close, [data-action="close"]');
    if (closeButton) {
      closeButton.click();
      return;
    }

    const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
    document.dispatchEvent(esc);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function extractPagination() {
    const pag = document.querySelector('.a-pagination');
    if (!pag) return { current: 1, total: 1 };

    const links = pag.querySelectorAll('a');
    let maxPage = 1;
    links.forEach(a => {
      const href = a.href;
      const match = href.match(/[?&]page=(\d+)/);
      if (match) maxPage = Math.max(maxPage, +match[1]);
    });

    const urlParams = new URLSearchParams(window.location.search);
    const current = +urlParams.get('page') || 1;
    return { current, total: maxPage };
  }

  function enhanceTile(tile, product) {
    // Remove old enhancements if re-processing
    tile.querySelectorAll('.ve-badge, .ve-keyword-tag').forEach(el => el.remove());

    const container = tile.querySelector('.vvp-item-tile-content') || tile;

    // ETV badge
    if (product.etv !== null) {
      const badge = document.createElement('div');
      badge.className = 've-badge ve-etv-badge';
      badge.textContent = `ETV: $${product.etv.toFixed(2)}`;
      container.appendChild(badge);
    }

    // Options badge
    if (product.hasOptions) {
      const optBadge = document.createElement('div');
      optBadge.className = 've-badge ve-options-badge';
      optBadge.textContent = 'Has Options';
      container.appendChild(optBadge);
    }

    // Keyword highlight
    if (product.keywordsMatched && product.keywordsMatched.length > 0) {
      tile.classList.add('ve-keyword-match');
      const tag = document.createElement('div');
      tag.className = 've-keyword-tag';
      tag.textContent = `\uD83D\uDD0D ${product.keywordsMatched.join(', ')}`;
      container.appendChild(tag);
    }

    // Unavailable overlay
    if (product.available === false) {
      tile.classList.add('ve-unavailable');
    }
  }

  // ── Detail panel scraping ──────────────────────────────────────────────────
  // The modal (#vvp-product-details-modal--main) already exists in the DOM.
  // Amazon shows/hides it by toggling style.display — NOT by adding/removing nodes.
  // We watch for the style attribute change to detect when it becomes visible.

  function watchDetailPanel() {
    function observeModal(modal) {
      let lastDisplay = modal.style.display;

      const obs = new MutationObserver(() => {
        const cur = modal.style.display;
        // Became visible (transitioned away from 'none' or '' initial hidden state)
        if (cur !== 'none' && cur !== '' && lastDisplay !== cur) {
          // Wait for ETV spinner to resolve before reading
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
      // Modal not yet in DOM — wait for it
      const waiter = new MutationObserver(() => {
        const m = document.getElementById('vvp-product-details-modal--main');
        if (m) { waiter.disconnect(); observeModal(m); }
      });
      waiter.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function extractFromDetailPanel(panel) {
    console.log('[VineExplorer] Detail panel triggered');
    // ASIN — from the product title link href  e.g. /dp/B0GS9J1KSQ
    const titleLink = panel.querySelector('#vvp-product-details-modal--product-title');
    if (!titleLink) { console.warn('[VineExplorer] No title link found in panel'); return; }
    const asinMatch = (titleLink.getAttribute('href') || '').match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) return;
    const asin = asinMatch[1];

    // ETV — #vvp-product-details-modal--tax-value-string  e.g. "$14.99"
    let etv = null;
    const etvEl = panel.querySelector('#vvp-product-details-modal--tax-value-string');
    if (etvEl) {
      const m = etvEl.textContent.match(/\$?([\d,]+\.?\d*)/);
      if (m) etv = parseFloat(m[1].replace(',', ''));
    }

    // Description — feature bullets list
    const descEl = panel.querySelector('#vvp-product-details-modal--feature-bullets');
    const description = descEl?.outerHTML?.trim() || '';

    // Vendor — "by SZHSYJY"  strip the leading "by "
    const vendorEl = panel.querySelector('#vvp-product-details-modal--by-line');
    const vendor = (vendorEl?.textContent || '').replace(/^by\s+/i, '').trim();

    // Has options — variations container has a select dropdown
    const hasOptions = !!panel.querySelector(
      '#vvp-product-details-modal--variations-container select'
    );

    // Title
    const title = titleLink.textContent?.trim() || undefined;

    const product = { asin, etv, description, vendor, hasOptions, available: true };
    if (title) product.title = title;

    const res = await send({ type: 'SAVE_PRODUCT', product });
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

  function findTileByAsin(asin) {
    // Search by data-asin attribute
    let tile = document.querySelector(`[data-asin="${asin}"].vvp-item-tile`);
    if (tile) return tile;

    // Search via button's recommendation id
    const btn = document.querySelector(`input[data-asin="${asin}"]`);
    if (btn) return btn.closest('.vvp-item-tile');

    return null;
  }

  // ── MutationObserver for infinite scroll / pagination ─────────────────────
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

  // ── Listen for rescrape request from service worker ────────────────────────
  function listenForRescrape() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'REQUEST_RESCRAPE') {
        processedAsins.clear();
        processAllTiles();
      } else if (msg.type === 'GET_PAGINATION_INFO') {
        const pagination = extractPagination();
        sendResponse(pagination);
      }
      return true;
    });
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  // Retries if the service worker isn't awake yet (MV3 SW is ephemeral).
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
              console.error('[VineExplorer] Message failed:', err.message, msg);
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
