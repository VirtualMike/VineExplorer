import { getAllProducts } from '../db/db.js';

const HOUR_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am',
  '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm',
  '6pm', '7pm', '8pm', '9pm', '10pm', '11pm'
];

const COLORS = [
  '#222244', // 0  (empty)
  '#0d3b66', // 1
  '#1b6b93', // 2
  '#3da5a9', // 3
  '#7ec88b', // 4
  '#c5e063', // 5
  '#f0c929', // 6
  '#f59e2a', // 7
  '#e8632b', // 8
  '#d62828', // 9+ (hottest)
];

async function init() {
  await render();
  document.getElementById('days-range').addEventListener('change', render);
}

async function render() {
  const days = parseInt(document.getElementById('days-range').value, 10) || 90;
  const products = await getAllProducts({ includeRemoved: true });

  const now    = Date.now();
  const cutoff = now - days * 86_400_000;

  // Bucket products by day + hour using productSiteLaunchDate
  const buckets = {};
  let totalInRange = 0;
  let maxCount = 0;

  for (const p of products) {
    const ts = p.productSiteLaunchDate;
    if (!ts || ts < cutoff) continue;

    const d    = new Date(ts);
    const dayKey  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hour = d.getHours();
    const key  = `${dayKey}|${hour}`;

    buckets[key] = (buckets[key] || 0) + 1;
    if (buckets[key] > maxCount) maxCount = buckets[key];
    totalInRange++;
  }

  // Build the list of days (oldest to newest, left to right)
  const dayList = [];
  const startDate = new Date(cutoff);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    dayList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  // Update summary
  document.getElementById('summary').textContent =
    `${totalInRange.toLocaleString()} products with launch dates in the last ${days} days (max ${maxCount}/hour)`;

  // Build the grid
  const grid = document.getElementById('heatmap-grid');
  grid.innerHTML = '';

  // Set grid columns: hour-label column + one column per day
  grid.style.gridTemplateColumns = `48px repeat(${dayList.length}, 14px)`;

  // Row 0: day labels (only show every Nth day to avoid crowding)
  const labelInterval = dayList.length > 60 ? 7 : dayList.length > 30 ? 3 : 1;

  // Top-left corner (empty)
  const corner = document.createElement('div');
  grid.appendChild(corner);

  // Day labels
  for (let i = 0; i < dayList.length; i++) {
    const el = document.createElement('div');
    el.className = 'day-label';
    if (i % labelInterval === 0) {
      const d = new Date(dayList[i] + 'T00:00:00');
      el.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    el.style.gridRow = '1';
    el.style.gridColumn = `${i + 2}`;
    grid.appendChild(el);
  }

  // Hour rows
  for (let hour = 0; hour < 24; hour++) {
    // Hour label
    const label = document.createElement('div');
    label.className = 'hour-label';
    label.textContent = HOUR_LABELS[hour];
    label.style.gridRow = `${hour + 2}`;
    label.style.gridColumn = '1';
    grid.appendChild(label);

    // Cells for each day
    for (let i = 0; i < dayList.length; i++) {
      const dayKey = dayList[i];
      const key    = `${dayKey}|${hour}`;
      const count  = buckets[key] || 0;

      const cell = document.createElement('div');
      cell.className = count > 0 ? 'cell' : 'cell cell-empty';
      cell.style.background = getColor(count, maxCount);
      cell.style.gridRow    = `${hour + 2}`;
      cell.style.gridColumn = `${i + 2}`;

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

function getColor(count, maxCount) {
  if (count === 0) return COLORS[0];
  if (maxCount <= 0) return COLORS[0];
  // Map count to 1-9 scale (logarithmic for better distribution)
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
    swatch.title = i === 0 ? '0' : i === 9 ? `${maxCount}+` : '';
    container.appendChild(swatch);
  }
}

function showTooltip(e) {
  const cell = e.currentTarget;
  const tooltip = document.getElementById('tooltip');
  const d    = new Date(cell.dataset.day + 'T00:00:00');
  const day  = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hour = HOUR_LABELS[+cell.dataset.hour];
  const count = +cell.dataset.count;

  tooltip.innerHTML = `<span class="tt-count">${count}</span> product${count !== 1 ? 's' : ''}<br>${day} at ${hour}`;
  tooltip.classList.remove('hidden');

  const rect = cell.getBoundingClientRect();
  tooltip.style.left = `${rect.right + 8}px`;
  tooltip.style.top  = `${rect.top - 4}px`;

  // Keep tooltip on screen
  const tr = tooltip.getBoundingClientRect();
  if (tr.right > window.innerWidth - 8) {
    tooltip.style.left = `${rect.left - tr.width - 8}px`;
  }
}

function hideTooltip() {
  document.getElementById('tooltip').classList.add('hidden');
}

init();
