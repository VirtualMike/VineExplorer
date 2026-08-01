import { getAllOrders, getAllProducts } from '../db/db.js';
import { renderGenerateButton } from './dayHaul.js';

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

let orders   = [];       // all order records, imageUrl attached
let imageMap = new Map(); // asin -> imageUrl
let nav      = { level: 'year', year: null, month: null }; // drill-down state

async function init() {
  await loadData();
  renderBreadcrumb();
  renderCurrentLevel();
  renderTopDays();
  bindEvents();
}

async function loadData() {
  // Origin-local page — read IndexedDB directly, same as compact/heatmap views.
  const [allOrders, products] = await Promise.all([
    getAllOrders(),
    getAllProducts({ includeRemoved: true })
  ]);
  imageMap = new Map(products.filter(p => p.imageUrl).map(p => [p.asin, p.imageUrl]));

  // Precompute calendar parts once so filters/aggregation avoid per-pass Date allocation.
  orders = allOrders.map(o => {
    const d = o.orderDate != null ? new Date(o.orderDate) : null;
    return {
      ...o,
      imageUrl: imageMap.get(o.asin) || null,
      _y: d ? d.getFullYear() : null,
      _m: d ? d.getMonth() : null,
      _d: d ? d.getDate() : null
    };
  });
}

// ── Aggregation helpers ──────────────────────────────────────────────────────
// Net total sums ETV directly (cancellations are negative → auto-net).

function ordersInScope() {
  return orders.filter(o => {
    if (o._y == null) return false;
    if (nav.year !== null && o._y !== nav.year) return false;
    if (nav.month !== null && o._m !== nav.month) return false;
    return true;
  });
}

function aggregate(list, keyFn) {
  const map = new Map();
  for (const o of list) {
    const k = keyFn(o);
    if (!map.has(k)) map.set(k, { net: 0, orderCount: 0, cancelCount: 0, items: [] });
    const bucket = map.get(k);
    bucket.net += o.etv || 0;
    if (o.orderType === 'CANCELLATION') bucket.cancelCount++;
    else bucket.orderCount++;
    bucket.items.push(o);
  }
  return map;
}

function money(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  const parts = [];
  parts.push(`<a data-nav="all">All Years</a>`);
  if (nav.year !== null) {
    parts.push(`<span class="sep">›</span>`);
    if (nav.month !== null) {
      parts.push(`<a data-nav="year" data-year="${nav.year}">${nav.year}</a>`);
      parts.push(`<span class="sep">›</span>`);
      parts.push(`<span class="current">${MONTH_NAMES[nav.month]}</span>`);
    } else {
      parts.push(`<span class="current">${nav.year}</span>`);
    }
  }
  bc.innerHTML = parts.join(' ');
  bc.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      const t = a.dataset.nav;
      if (t === 'all')  nav = { level: 'year', year: null, month: null };
      if (t === 'year') nav = { level: 'month', year: +a.dataset.year, month: null };
      renderBreadcrumb();
      renderCurrentLevel();
    });
  });
}

// Derives the summary cards from the already-built aggregate buckets — no extra
// passes over the raw order list.
function renderSummaryCards(buckets) {
  let net = 0, orderN = 0, cancelN = 0;
  for (const b of buckets.values()) {
    net += b.net;
    orderN += b.orderCount;
    cancelN += b.cancelCount;
  }
  const activeDays = countActiveDays(buckets);

  const cards = [
    { val: money(net), label: 'Net ETV', cls: 'net' },
    { val: orderN,     label: 'Orders' },
    { val: cancelN,    label: 'Cancellations' },
    { val: activeDays, label: 'Active Days' }
  ];
  document.getElementById('summary-cards').innerHTML = cards.map(c =>
    `<div class="summary-card ${c.cls || ''}"><div class="val">${c.val}</div><div class="label">${c.label}</div></div>`
  ).join('');
}

// At year/month level buckets aren't per-day, so count distinct days from items.
function countActiveDays(buckets) {
  if (nav.year !== null && nav.month !== null) return buckets.size; // day-level: one bucket per day
  const days = new Set();
  for (const b of buckets.values()) {
    for (const o of b.items) if (o._y != null) days.add(`${o._y}-${o._m}-${o._d}`);
  }
  return days.size;
}

const DRILL_LEVELS = {
  year:  { keyFn: o => o._y, sort: (a, b) => b - a, label: y => `${y}` },
  month: { keyFn: o => o._m, sort: (a, b) => a - b, label: m => MONTH_NAMES[m] },
  day:   { keyFn: o => o._d, sort: (a, b) => a - b, label: d => `${MONTH_NAMES[nav.month].slice(0,3)} ${d}` }
};

function renderCurrentLevel() {
  const scope   = ordersInScope();
  const level   = nav.year === null ? 'year' : nav.month === null ? 'month' : 'day';
  const cfg     = DRILL_LEVELS[level];
  const buckets = aggregate(scope, cfg.keyFn);

  renderSummaryCards(buckets);

  const view    = document.getElementById('drill-view');
  const undated = orders.reduce((n, o) => n + (o._y == null ? 1 : 0), 0);

  const keys = [...buckets.keys()].sort(cfg.sort);
  if (keys.length === 0) return renderEmpty(view, undated);

  view.innerHTML = keys.map(k => periodCard(k, buckets.get(k), cfg.label(k))).join('');
  wirePeriodCards(view, level);
}

function renderEmpty(view, undated) {
  const extra = undated > 0 ? `<br><span class="hint">(${undated} order(s) have no order date and can't be shown by date)</span>` : '';
  view.innerHTML = `<div class="empty-state">No orders found. Open amazon.com/vine/account and click "Refresh Orders" to import.${extra}</div>`;
}

function periodCard(key, bucket, label) {
  return `<div class="period-card" data-key="${key}">
    <div class="period-name">${label}</div>
    <div class="period-total">${money(bucket.net)}</div>
    <div class="period-meta">${bucket.orderCount} order${bucket.orderCount !== 1 ? 's' : ''}${bucket.cancelCount ? ` · ${bucket.cancelCount} cancelled` : ''}</div>
  </div>`;
}

function wirePeriodCards(view, level) {
  view.querySelectorAll('.period-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = +card.dataset.key;
      if (level === 'day') { openDayModal(nav.year, nav.month, key); return; }
      nav = level === 'year'
        ? { level: 'month', year: key, month: null }
        : { level: 'day', year: nav.year, month: key };
      renderBreadcrumb();
      renderCurrentLevel();
    });
  });
}

// ── Top 20 days ──────────────────────────────────────────────────────────────
function renderTopDays() {
  const byDay = aggregate(orders.filter(o => o._y != null), o => `${o._y}-${o._m}-${o._d}`);
  const sorted = [...byDay.entries()]
    .sort((a, b) => b[1].net - a[1].net)
    .slice(0, 20);

  const ol = document.getElementById('top-days');
  if (sorted.length === 0) { ol.innerHTML = '<li class="hint">No orders yet</li>'; return; }

  ol.innerHTML = sorted.map(([key, bucket]) => {
    const [y, m, d] = key.split('-').map(Number);
    const label = `${MONTH_NAMES[m].slice(0,3)} ${d}, ${y}`;
    return `<li data-y="${y}" data-m="${m}" data-d="${d}">
      <span class="td-date">${label}</span>
      <span class="td-total">${money(bucket.net)}</span>
    </li>`;
  }).join('');

  ol.querySelectorAll('li[data-y]').forEach(li => {
    li.addEventListener('click', () => {
      openDayModal(+li.dataset.y, +li.dataset.m, +li.dataset.d);
    });
  });
}

// ── Day detail modal ─────────────────────────────────────────────────────────
function openDayModal(year, month, day) {
  const orderedItems   = [];
  const cancelledItems = [];
  let net = 0, gross = 0;
  for (const o of orders) {
    if (o._y !== year || o._m !== month || o._d !== day) continue;
    net += o.etv || 0;
    if (o.orderType === 'CANCELLATION') {
      cancelledItems.push(o);
    } else {
      orderedItems.push(o);
      gross += o.etv || 0;
    }
  }
  const dateLabel = `${MONTH_NAMES[month]} ${day}, ${year}`;

  const content = document.getElementById('day-modal-content');
  content.innerHTML = `
    <div class="day-header"><h2>${dateLabel}</h2></div>
    <div class="day-stats">
      <span class="stat">Net ETV: <b>${money(net)}</b></span>
      <span class="stat">Gross: ${money(gross)}</span>
      <span class="stat">${orderedItems.length} order${orderedItems.length !== 1 ? 's' : ''}</span>
      ${cancelledItems.length ? `<span class="stat">${cancelledItems.length} cancelled</span>` : ''}
    </div>
    <div class="generate-bar" id="generate-bar"></div>
    <div class="haul-result hidden" id="haul-result"></div>
    <div class="day-tiles" id="day-tiles"></div>
    ${cancelledItems.length ? `<div class="cancellation-note">Cancellations: ${cancelledItems.map(c => escapeHtml(shortName(c.productName))).join(', ')}</div>` : ''}
  `;

  const tiles = content.querySelector('#day-tiles');
  tiles.innerHTML = orderedItems.map(o => orderTile(o)).join('');

  // Wire the Day's Haul generate button
  renderGenerateButton({
    mount:     content.querySelector('#generate-bar'),
    resultEl:  content.querySelector('#haul-result'),
    items:     orderedItems.map(o => ({ imageUrl: o.imageUrl, name: shortName(o.productName), price: o.etv })),
    total:     gross,
    dateLabel
  });

  document.getElementById('day-modal').classList.remove('hidden');
}

function orderTile(o) {
  const img = o.imageUrl
    ? `<img src="${o.imageUrl}" alt="" loading="lazy" />`
    : `<div style="height:120px;background:#fafafa;border-radius:4px;"></div>`;
  return `<div class="order-tile">
    <a href="https://www.amazon.com/dp/${o.asin}" target="_blank" rel="noopener">
      ${img}
      <div class="ot-name">${escapeHtml(shortName(o.productName))}</div>
    </a>
    <div class="ot-price">${money(o.etv || 0)}</div>
  </div>`;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function shortName(name) {
  if (!name) return '(untitled)';
  return name.length > 70 ? name.slice(0, 67) + '…' : name;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function bindEvents() {
  document.getElementById('day-modal-close').addEventListener('click', closeModal);
  document.getElementById('day-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  const btn = document.getElementById('btn-refresh');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const status = document.getElementById('refresh-status');
    status.textContent = 'Refreshing…';
    const thisYear = new Date().getFullYear();
    const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_ORDER_IMPORT', years: [thisYear, thisYear - 1] });
    if (res?.ok) {
      status.textContent = `+${res.added || 0} new, ${res.updated || 0} updated`;
      await loadData();
      renderBreadcrumb(); renderCurrentLevel(); renderTopDays();
    } else {
      status.textContent = res?.error || 'Refresh failed';
    }
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 6000);
  });
}

function closeModal() {
  document.getElementById('day-modal').classList.add('hidden');
}

init();
