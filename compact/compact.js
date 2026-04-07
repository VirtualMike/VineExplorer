// compact/compact.js — Full-page product table view
import { getAllProducts, searchProducts, getKeywords } from '../db/db.js';

// ── State ───────────────────────────────────────────────────────────────────
let allProducts  = [];
let sortCol      = 'dateFirstSeen';
let sortDir      = 'desc';
let debounceTimer = null;

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  allProducts = await getAllProducts({ includeRemoved: false });
  render();
  bindEvents();
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const query          = document.getElementById('search-input').value;
  const minEtv         = document.getElementById('min-etv').value;
  const maxEtv         = document.getElementById('max-etv').value;
  const keywordsOnly   = document.getElementById('keywords-only').checked;
  const includeRemoved = document.getElementById('include-removed').checked;

  let source = includeRemoved
    ? getAllProductsSync(true)
    : allProducts;

  // Filter
  const lq = query.trim().toLowerCase();
  let results = source.filter(p => {
    if (lq) {
      const inTitle = p.title.toLowerCase().includes(lq);
      const inDesc  = p.description.toLowerCase().includes(lq);
      if (!inTitle && !inDesc) return false;
    }
    if (minEtv !== '' && (p.etv === null || p.etv < +minEtv)) return false;
    if (maxEtv !== '' && (p.etv === null || p.etv > +maxEtv)) return false;
    if (keywordsOnly && (!p.keywordsMatched || p.keywordsMatched.length === 0)) return false;
    if (!includeRemoved && p.available === false) return false;
    return true;
  });

  // Sort
  results.sort((a, b) => {
    let av = a[sortCol] ?? '';
    let bv = b[sortCol] ?? '';
    if (sortCol === 'etv') {
      av = a.etv ?? -Infinity;
      bv = b.etv ?? -Infinity;
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });

  document.getElementById('result-count').textContent =
    `${results.length} product${results.length === 1 ? '' : 's'}`;

  const tbody = document.getElementById('product-tbody');
  if (results.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No products found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const p of results) {
    tbody.appendChild(buildRow(p));
  }
}

// In-memory snapshot for re-filtering without DB call when "include removed" is toggled
let _allIncludingRemoved = null;
function getAllProductsSync(includeRemoved) {
  if (!includeRemoved) return allProducts;
  return _allIncludingRemoved ?? allProducts;
}

function buildRow(p) {
  const tr = document.createElement('tr');
  if (p.keywordsMatched?.length > 0) tr.classList.add('kw-match');
  if (p.available === false) tr.classList.add('removed');

  // Image
  const imgCell = document.createElement('td');
  imgCell.className = 'col-img';
  if (p.imageUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const img = document.createElement('img');
    img.src = p.imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);
    // Zoom on hover — handled via CSS
    imgCell.appendChild(wrap);
  }
  tr.appendChild(imgCell);

  // Title
  const titleCell = document.createElement('td');
  titleCell.className = 'col-title';
  const link = document.createElement('a');
  link.href = `https://www.amazon.com/dp/${p.asin}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = p.title || p.asin;
  titleCell.appendChild(link);
  if (p.keywordsMatched?.length > 0) {
    const tag = document.createElement('div');
    tag.className = 'kw-tag';
    tag.textContent = p.keywordsMatched.join(', ');
    titleCell.appendChild(tag);
  }
  tr.appendChild(titleCell);

  // Vendor
  const vendorCell = document.createElement('td');
  vendorCell.className = 'col-vendor';
  vendorCell.textContent = p.vendor || '—';
  tr.appendChild(vendorCell);

  // Description
  const descCell = document.createElement('td');
  descCell.className = 'col-desc';
  if (p.description) {
    const plain = htmlToPlainText(p.description);
    const short = plain.length > 120 ? plain.slice(0, 120) + '…' : plain;
    const shortSpan = document.createElement('span');
    shortSpan.textContent = short;
    descCell.appendChild(shortSpan);

    if (plain.length > 120) {
      const more = document.createElement('button');
      more.className = 'btn-more';
      more.textContent = 'More';
      more.addEventListener('click', () => showDescPopover(p.title, p.description));
      descCell.appendChild(more);
    }
  } else {
    descCell.textContent = '—';
  }
  tr.appendChild(descCell);

  // Options
  const optsCell = document.createElement('td');
  optsCell.className = 'col-opts';
  optsCell.textContent = p.hasOptions ? '✓' : '';
  tr.appendChild(optsCell);

  // ETV
  const etvCell = document.createElement('td');
  etvCell.className = 'col-etv';
  etvCell.textContent = p.etv !== null ? `$${p.etv.toFixed(2)}` : '—';
  tr.appendChild(etvCell);

  // Date first seen
  const dateCell = document.createElement('td');
  dateCell.className = 'col-date';
  dateCell.textContent = p.dateFirstSeen
    ? new Date(p.dateFirstSeen).toLocaleDateString()
    : '—';
  tr.appendChild(dateCell);

  // Status
  const statusCell = document.createElement('td');
  statusCell.className = 'col-status';
  if (p.available === false) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-removed';
    badge.textContent = 'Removed';
    statusCell.appendChild(badge);
  } else {
    const badge = document.createElement('span');
    badge.className = 'badge badge-avail';
    badge.textContent = 'Available';
    statusCell.appendChild(badge);
  }
  tr.appendChild(statusCell);

  return tr;
}

function htmlToPlainText(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

// ── Description popover ───────────────────────────────────────────────────────
function showDescPopover(title, html) {
  const popover = document.getElementById('desc-popover');
  const content = document.getElementById('desc-content');
  // Keep the close button, replace the rest
  content.innerHTML = `
    <button id="desc-close" class="desc-close">✕</button>
    <h3>${escapeHtml(title)}</h3>
    <div class="desc-body">${html}</div>
  `;
  content.querySelector('#desc-close').addEventListener('click', () => {
    popover.classList.add('hidden');
  });
  popover.classList.remove('hidden');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Debounced search
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 200);
  });

  // Filter changes
  ['min-etv', 'max-etv'].forEach(id =>
    document.getElementById(id).addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(render, 300);
    })
  );

  document.getElementById('keywords-only').addEventListener('change', render);

  document.getElementById('include-removed').addEventListener('change', async (e) => {
    if (e.target.checked && !_allIncludingRemoved) {
      const { getAllProducts } = await import('../db/db.js');
      _allIncludingRemoved = await getAllProducts({ includeRemoved: true });
    }
    render();
  });

  // Sort on column header click
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'etv' ? 'desc' : 'asc';
      }
      // Update header arrows
      document.querySelectorAll('th.sortable').forEach(h => {
        h.classList.toggle('sort-active', h.dataset.col === sortCol);
      });
      render();
    });
  });

  // Popover — close on backdrop click
  document.getElementById('desc-popover').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
    }
  });
}

init();
