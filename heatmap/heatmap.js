import { getAllProducts } from '../db/db.js';

const HOUR_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am',
  '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm',
  '6pm', '7pm', '8pm', '9pm', '10pm', '11pm'
];

const DOW_LETTERS = ['S', 'M', 'T', 'W', 'R', 'F', 'S'];

const COLORS = [
  '#222244',
  '#0d3b66',
  '#1b6b93',
  '#3da5a9',
  '#7ec88b',
  '#c5e063',
  '#f0c929',
  '#f59e2a',
  '#e8632b',
  '#d62828',
];

// Base cell size (px) before zoom — 50% larger than original 14x16
const BASE_W = 21;
const BASE_H = 24;

let weekStartDay = 0; // 0=Sunday by default
let zoomPct = 100;

async function init() {
  // Load week-start setting
  try {
    const stored = await chrome.storage.local.get({ weekStartDay: 0 });
    weekStartDay = stored.weekStartDay;
  } catch { /* default */ }

  await render();

  document.getElementById('days-range').addEventListener('change', render);
  const slider = document.getElementById('zoom-slider');
  slider.addEventListener('input', () => {
    zoomPct = parseInt(slider.value, 10);
    document.getElementById('zoom-value').textContent = `${zoomPct}%`;
    applyZoom();
  });
}

function applyZoom() {
  const grid = document.getElementById('heatmap-grid');
  const scale = zoomPct / 100;
  const cellW = Math.round(BASE_W * scale);
  const cellH = Math.round(BASE_H * scale);

  grid.style.setProperty('--cell-w', `${cellW}px`);
  grid.style.setProperty('--cell-h', `${cellH}px`);

  // Rebuild grid-template-columns with the new cell width
  const colDefs = grid.dataset.colDefs;
  if (colDefs) {
    grid.style.gridTemplateColumns = colDefs.replace(/CW/g, `${cellW}px`);
  }
  grid.style.gridTemplateRows = `auto auto repeat(24, ${cellH}px)`;

  grid.querySelectorAll('.cell').forEach(c => {
    c.style.width  = `${cellW}px`;
    c.style.height = `${cellH}px`;
  });
  grid.querySelectorAll('.week-sep').forEach(c => {
    c.style.height = `${cellH}px`;
  });
}

async function render() {
  const days = parseInt(document.getElementById('days-range').value, 10) || 90;
  const products = await getAllProducts({ includeRemoved: true });

  const now    = Date.now();
  const cutoff = now - days * 86_400_000;

  // Bucket products by day + hour
  const buckets = {};
  let totalInRange = 0;
  let maxCount = 0;

  for (const p of products) {
    const ts = p.productSiteLaunchDate;
    if (!ts || ts < cutoff) continue;

    const d       = new Date(ts);
    const dayKey  = dateToDayKey(d);
    const hour    = d.getHours();
    const key     = `${dayKey}|${hour}`;

    buckets[key] = (buckets[key] || 0) + 1;
    if (buckets[key] > maxCount) maxCount = buckets[key];
    totalInRange++;
  }

  // Build day list (oldest → newest)
  const dayList = [];
  const startDate = new Date(cutoff);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const key = dateToDayKey(d);
    const dow = d.getDay();
    dayList.push({ key, dow, date: new Date(d) });
  }

  document.getElementById('summary').textContent =
    `${totalInRange.toLocaleString()} products in ${days} days (max ${maxCount}/hr)`;

  // Determine column layout: hour-label + (day columns with 1px separator at week boundaries)
  // A week boundary is where the day-of-week equals weekStartDay
  const scale = zoomPct / 100;
  const cellW = Math.round(BASE_W * scale);
  const cellH = Math.round(BASE_H * scale);

  // Build column definitions and track which grid-column each day lands on
  // Columns: [hour-label] [sep?] [day] [sep?] [day] ...
  const colParts = ['48px']; // hour label column
  const dayColumns = [];     // maps dayList index → grid column number (1-based)
  let col = 2;

  for (let i = 0; i < dayList.length; i++) {
    // Insert separator before this day if it's the week-start and not the first day
    if (i > 0 && dayList[i].dow === weekStartDay) {
      colParts.push('1px');
      col++;
    }
    colParts.push('CW');
    dayColumns.push(col);
    col++;
  }

  const grid = document.getElementById('heatmap-grid');
  grid.innerHTML = '';
  grid.dataset.colDefs = `48px ${colParts.slice(1).join(' ')}`;
  grid.style.gridTemplateColumns = grid.dataset.colDefs.replace(/CW/g, `${cellW}px`);
  grid.style.gridTemplateRows = `auto auto repeat(24, ${cellH}px)`;

  // Row 1: date labels (show every Nth)
  const labelInterval = dayList.length > 60 ? 7 : dayList.length > 30 ? 3 : 1;

  // Top-left corners (span rows 1-2)
  const corner = document.createElement('div');
  corner.style.gridRow = '1 / 3';
  corner.style.gridColumn = '1';
  grid.appendChild(corner);

  for (let i = 0; i < dayList.length; i++) {
    // Date label (row 1)
    const el = document.createElement('div');
    el.className = 'day-label';
    if (i % labelInterval === 0) {
      const d = dayList[i].date;
      el.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    el.style.gridRow = '1';
    el.style.gridColumn = `${dayColumns[i]}`;
    grid.appendChild(el);

    // Day-of-week letter (row 2)
    const dowEl = document.createElement('div');
    dowEl.className = 'dow-label';
    dowEl.textContent = DOW_LETTERS[dayList[i].dow];
    dowEl.style.gridRow = '2';
    dowEl.style.gridColumn = `${dayColumns[i]}`;
    grid.appendChild(dowEl);
  }

  // Hour rows (rows 3-26)
  for (let hour = 0; hour < 24; hour++) {
    const gridRow = hour + 3;

    // Hour label
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.textContent = HOUR_LABELS[hour];
    label.style.gridRow = `${gridRow}`;
    label.style.gridColumn = '1';
    grid.appendChild(label);

    // Cells + separators
    let sepCol = 2;
    for (let i = 0; i < dayList.length; i++) {
      // Week separator
      if (i > 0 && dayList[i].dow === weekStartDay) {
        const sep = document.createElement('div');
        sep.className = 'week-sep';
        sep.style.gridRow    = `${gridRow}`;
        sep.style.gridColumn = `${dayColumns[i] - 1}`;
        sep.style.height     = `${cellH}px`;
        grid.appendChild(sep);
      }

      const dayKey = dayList[i].key;
      const key    = `${dayKey}|${hour}`;
      const count  = buckets[key] || 0;

      const cell = document.createElement('div');
      cell.className = count > 0 ? 'cell' : 'cell cell-empty';
      cell.style.background = getColor(count, maxCount);
      cell.style.gridRow    = `${gridRow}`;
      cell.style.gridColumn = `${dayColumns[i]}`;
      cell.style.width      = `${cellW}px`;
      cell.style.height     = `${cellH}px`;

      cell.dataset.day   = dayKey;
      cell.dataset.hour  = hour;
      cell.dataset.count = count;

      cell.addEventListener('mouseenter', showTooltip);
      cell.addEventListener('mouseleave', hideTooltip);

      grid.appendChild(cell);
    }
  }

  renderLegend(maxCount);
}

function dateToDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getColor(count, maxCount) {
  if (count === 0) return COLORS[0];
  if (maxCount <= 0) return COLORS[0];
  const ratio = Math.log(count + 1) / Math.log(maxCount + 1);
  const idx   = Math.min(9, Math.max(1, Math.ceil(ratio * 9)));
  return COLORS[idx];
}

function renderLegend(maxCount) {
  const container = document.getElementById('legend-scale');
  container.innerHTML = '';
  for (let i = 0; i < COLORS.length; i++) {
    const swatch = document.createElement('div');
    swatch.className = 'legend-swatch';
    swatch.style.background = COLORS[i];
    swatch.title = i === 0 ? '0' : i === COLORS.length - 1 ? `${maxCount}+` : '';
    container.appendChild(swatch);
  }
}

function showTooltip(e) {
  const cell    = e.currentTarget;
  const tooltip = document.getElementById('tooltip');
  const d       = new Date(cell.dataset.day + 'T00:00:00');
  const dayStr  = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hour    = HOUR_LABELS[+cell.dataset.hour];
  const count   = +cell.dataset.count;

  tooltip.innerHTML = `<span class="tt-count">${count}</span> product${count !== 1 ? 's' : ''}<br>${dayStr} at ${hour}`;
  tooltip.classList.remove('hidden');

  const rect = cell.getBoundingClientRect();
  tooltip.style.left = `${rect.right + 8}px`;
  tooltip.style.top  = `${rect.top - 4}px`;

  const tr = tooltip.getBoundingClientRect();
  if (tr.right > window.innerWidth - 8) {
    tooltip.style.left = `${rect.left - tr.width - 8}px`;
  }
}

function hideTooltip() {
  document.getElementById('tooltip').classList.add('hidden');
}

init();
