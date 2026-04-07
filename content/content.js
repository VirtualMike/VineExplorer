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

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    await loadKeywords();
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
    tiles.forEach(processTile);
  }

  async function processTile(tile) {
    const asin = extractAsin(tile);
    if (!asin || processedAsins.has(asin)) return;
    processedAsins.add(asin);

    const product = extractProductFromTile(tile, asin);
    if (!product) return;

    // Save to DB (SW will check keyword matches)
    const res = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    // Enhance the tile with cached data
    if (saved) {
      enhanceTile(tile, saved);
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
  // When the user clicks "See details", Amazon shows a modal/drawer.
  // We watch for it and extract ETV + description.

  function watchDetailPanel() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const panel = node.matches?.('#vvp-product-details-modal--content, .vvp-details-tab--content')
            ? node
            : node.querySelector?.('#vvp-product-details-modal--content, .vvp-details-tab--content');

          if (panel) {
            // Small delay to ensure content is fully rendered
            setTimeout(() => extractFromDetailPanel(panel), 300);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function extractFromDetailPanel(panel) {
    // ASIN — try to find from a "Add to queue" button or data attributes
    const orderBtn = panel.querySelector('input[data-asin], [data-asin]');
    let asin = orderBtn?.getAttribute('data-asin');

    if (!asin) {
      // Try the recommendation-id attribute
      const recInput = panel.querySelector('input[data-recommendation-id]');
      if (recInput) {
        const recId = recInput.getAttribute('data-recommendation-id') || '';
        asin = recId.split('|').find(p => /^[A-Z0-9]{10}$/.test(p));
      }
    }

    if (!asin) return;

    // ETV — Amazon shows it in a span with specific text
    let etv = null;
    const etvEl = panel.querySelector(
      '.vvp-product-details-modal--etv-amount, ' +
      '[class*="etv-amount"], ' +
      '[class*="etv"]'
    );
    if (etvEl) {
      const match = etvEl.textContent.match(/\$?([\d,]+\.?\d*)/);
      if (match) etv = parseFloat(match[1].replace(',', ''));
    }

    // Fallback: search all text for "Est. Tax Value" pattern
    if (etv === null) {
      const allText = panel.textContent || '';
      const etvMatch = allText.match(/[Ee]st(?:imated)?\s+[Tt]ax\s+[Vv]alue[:\s]+\$?([\d,]+\.?\d*)/);
      if (etvMatch) etv = parseFloat(etvMatch[1].replace(',', ''));
    }

    // Description
    const descEl = panel.querySelector(
      '.vvp-product-details-modal--description-text, ' +
      '[class*="description-text"], ' +
      '.a-expander-content'
    );
    const description = descEl?.innerHTML?.trim() || '';

    // Vendor/Brand
    const vendorEl = panel.querySelector('[class*="vendor"], [class*="brand"], .a-size-base.ve-vendor');
    const vendor = vendorEl?.textContent?.trim() || '';

    // Has options (select/dropdown in the panel)
    const hasOptions = !!panel.querySelector('select, .a-dropdown-container');

    // Title (may already be stored, but grab it if available)
    const titleEl = panel.querySelector(
      '.vvp-product-details-modal--product-title, ' +
      '[class*="product-title"]'
    );
    const title = titleEl?.textContent?.trim() || undefined;

    const product = { asin, etv, description, vendor, hasOptions, available: true };
    if (title) product.title = title;

    const res = await send({ type: 'SAVE_PRODUCT', product });
    const saved = res?.product;

    // Update the tile in the page (if visible)
    if (saved) {
      const tile = findTileByAsin(asin);
      if (tile) {
        processedAsins.delete(asin); // allow re-enhancement
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
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'REQUEST_RESCRAPE') {
        processedAsins.clear();
        processAllTiles();
      }
    });
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({});
        } else {
          resolve(res ?? {});
        }
      });
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
