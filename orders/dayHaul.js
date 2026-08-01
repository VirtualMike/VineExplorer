// orders/dayHaul.js — "Day's Haul" image generator
// Three backends: local canvas composite (default, no API), Google Gemini
// (gemini-2.5-flash-image / "nano banana"), and OpenAI (gpt-image-1).
// The Generate control is a split button: main action runs the last-used
// backend; the caret opens a menu to pick a different one for this event.

const PROMPT = `Create a social media hook image called "Day's Haul" with images of each item as stamps randomly placed around the screen. Each image has a sale tag on it with the price and near the bottom right should be a bold cartoonish number that is the total of the Day's orders. The total should not overlap too much of the pictures, and none of the prices. Future goal is to make a short/reel that has the items coming onto the page with a BAM, as each one lands.`;

const BACKENDS = {
  canvas: { label: 'Local Canvas (free)',  needsKey: null,           generate: generateCanvas },
  gemini: { label: 'Gemini (nano banana)', needsKey: 'geminiApiKey', generate: generateGemini },
  openai: { label: 'OpenAI (gpt-image-1)', needsKey: 'openaiApiKey', generate: generateOpenAI }
};

const MAX_ITEMS = 12;

export async function renderGenerateButton({ mount, resultEl, items, total, dateLabel }) {
  const settings = await chrome.storage.local.get({
    dayHaulBackend: 'canvas',
    geminiApiKey:   '',
    openaiApiKey:   ''
  });

  let current = settings.dayHaulBackend in BACKENDS ? settings.dayHaulBackend : 'canvas';

  mount.innerHTML = `
    <div class="split-btn">
      <button class="btn btn-primary main" id="dh-main"></button>
      <button class="btn btn-primary caret" id="dh-caret" title="Choose generator">▾</button>
      <div class="split-menu hidden" id="dh-menu"></div>
    </div>
    <span class="hint" id="dh-hint"></span>
  `;

  const mainBtn = mount.querySelector('#dh-main');
  const caret   = mount.querySelector('#dh-caret');
  const menu    = mount.querySelector('#dh-menu');
  const hint    = mount.querySelector('#dh-hint');

  function keyPresent(backend) {
    const kn = BACKENDS[backend].needsKey;
    return !kn || !!settings[kn];
  }

  function refreshMain() {
    mainBtn.textContent = `Generate — ${BACKENDS[current].label}`;
    hint.textContent = keyPresent(current) ? '' : 'API key not set (see extension settings)';
  }

  menu.innerHTML = Object.entries(BACKENDS).map(([k, v]) => {
    const ok = keyPresent(k);
    return `<button data-backend="${k}" ${ok ? '' : 'disabled'}>${v.label}${ok ? '' : ' — no key'}</button>`;
  }).join('');

  refreshMain();

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));

  menu.querySelectorAll('button[data-backend]').forEach(b => {
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      current = b.dataset.backend;
      await chrome.storage.local.set({ dayHaulBackend: current });
      refreshMain();
      menu.classList.add('hidden');
      runGeneration();
    });
  });

  mainBtn.addEventListener('click', runGeneration);

  async function runGeneration() {
    if (!keyPresent(current)) {
      hint.textContent = 'API key not set (see extension settings)';
      return;
    }
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<div class="haul-spinner">Generating "Day's Haul" with ${BACKENDS[current].label}…</div>`;
    mainBtn.disabled = true;

    try {
      const prepped = await getPreppedItems();
      const blob    = await BACKENDS[current].generate(prepped, total, dateLabel, settings);
      showResult(resultEl, blob, dateLabel);
    } catch (err) {
      console.error('[VineExplorer] Day\'s Haul generation failed:', err);
      resultEl.innerHTML = `<div class="haul-error">Generation failed: ${escapeHtml(err.message)}</div>`;
      if (BACKENDS[current].needsKey) {
        resultEl.innerHTML += `<div class="hint">Tip: the Local Canvas option always works without an API key.</div>`;
      }
    } finally {
      mainBtn.disabled = false;
    }
  }

  // Load + decode each item image once; reused across regenerations and backend switches.
  let preppedPromise = null;
  function getPreppedItems() {
    if (!preppedPromise) preppedPromise = prepItems(items);
    return preppedPromise;
  }
}

function showResult(resultEl, blob, dateLabel) {
  const url = URL.createObjectURL(blob);
  resultEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  resultEl.appendChild(img);

  const bar = document.createElement('div');
  bar.style.marginTop = '10px';
  bar.style.display = 'flex';
  bar.style.gap = '10px';

  const dl = document.createElement('a');
  dl.className = 'btn btn-primary';
  dl.textContent = 'Download';
  dl.href = url;
  dl.download = `Days-Haul-${dateLabel.replace(/[^\w]+/g, '-')}.png`;
  bar.appendChild(dl);

  resultEl.appendChild(bar);
}

// ── Item preparation ─────────────────────────────────────────────────────────
// Loads each item image (crossOrigin) and returns { img, name, price }.

async function prepItems(items) {
  const withImg = items.filter(i => i.imageUrl).slice(0, MAX_ITEMS);
  const loaded  = await Promise.all(withImg.map(async i => {
    try {
      const img = await loadImage(i.imageUrl);
      return { ...i, img };
    } catch {
      return null;
    }
  }));
  return loaded.filter(Boolean);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function imgToBlob(img) {
  const canvas = document.createElement('canvas');
  canvas.width  = img.naturalWidth  || 180;
  canvas.height = img.naturalHeight || 180;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

async function imgToBase64(img) {
  return blobToBase64(await imgToBlob(img));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Canvas compositor (default backend) ──────────────────────────────────────
async function generateCanvas(items, total, dateLabel) {
  const SIZE = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  grad.addColorStop(0, '#fff4e0');
  grad.addColorStop(1, '#ffd9a0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Title
  ctx.fillStyle = '#232f3e';
  ctx.font = 'bold 64px Arial';
  ctx.textAlign = 'left';
  ctx.fillText("Day's Haul", 40, 80);
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#8a6d3b';
  ctx.fillText(dateLabel, 42, 118);

  // Deterministic pseudo-random placement (seeded by index) so the layout is
  // stable across regenerations of the same day. Reserve the bottom-right
  // quadrant for the total.
  const stampSize = items.length > 8 ? 220 : 280;
  const reserve   = { x: SIZE * 0.55, y: SIZE * 0.62 };

  items.forEach((item, i) => {
    const seed = (i + 1) * 2654435761 % 2147483647;
    const rx = ((seed % 1000) / 1000);
    const ry = (((seed >> 10) % 1000) / 1000);
    const rot = (((seed >> 5) % 100) / 100 - 0.5) * 0.5; // ±0.25 rad

    let x = 40 + rx * (SIZE - stampSize - 80);
    let y = 140 + ry * (SIZE - stampSize - 260);

    // Nudge stamps out of the reserved total area
    if (x + stampSize > reserve.x && y + stampSize > reserve.y) {
      y = reserve.y - stampSize - 10;
      if (y < 140) { x = reserve.x - stampSize - 10; y = 140 + ry * 200; }
    }

    ctx.save();
    ctx.translate(x + stampSize / 2, y + stampSize / 2);
    ctx.rotate(rot);

    // White stamp frame with shadow
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#fff';
    ctx.fillRect(-stampSize / 2 - 8, -stampSize / 2 - 8, stampSize + 16, stampSize + 16);
    ctx.shadowColor = 'transparent';

    // Item image (contain)
    drawContain(ctx, item.img, -stampSize / 2, -stampSize / 2, stampSize, stampSize);

    // Price tag (rotated slightly, bottom-left of stamp)
    const price = `$${(item.price || 0).toFixed(2)}`;
    ctx.save();
    ctx.rotate(-0.15);
    ctx.fillStyle = '#c0392b';
    const tagW = 30 + price.length * 18;
    ctx.fillRect(-stampSize / 2, stampSize / 2 - 30, tagW, 48);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(price, -stampSize / 2 + 14, stampSize / 2 + 3);
    ctx.restore();

    ctx.restore();
  });

  // Big cartoonish total, bottom-right
  const totalStr = `$${total.toFixed(2)}`;
  ctx.textAlign = 'right';
  ctx.font = 'bold 130px Arial';
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#232f3e';
  ctx.fillStyle = '#ffcc00';
  ctx.strokeText(totalStr, SIZE - 40, SIZE - 60);
  ctx.fillText(totalStr, SIZE - 40, SIZE - 60);
  ctx.font = 'bold 34px Arial';
  ctx.fillStyle = '#232f3e';
  ctx.fillText('TOTAL', SIZE - 46, SIZE - 150);

  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

function drawContain(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || w, ih = img.naturalHeight || h;
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// ── Gemini backend ───────────────────────────────────────────────────────────
async function generateGemini(items, total, dateLabel, settings) {
  const apiKey = settings.geminiApiKey;
  const parts = [{ text: `${PROMPT}\n\nThe day is ${dateLabel}. The total of the day's orders is $${total.toFixed(2)}. Item prices: ${items.map(i => '$' + (i.price||0).toFixed(2)).join(', ')}.` }];
  for (const it of items) {
    parts.push({ inline_data: { mime_type: 'image/png', data: await imgToBase64(it.img) } });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );

  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const imgPart = json?.candidates?.[0]?.content?.parts?.find(p => p.inline_data || p.inlineData);
  const data = imgPart?.inline_data?.data || imgPart?.inlineData?.data;
  if (!data) throw new Error('Gemini returned no image');
  return base64ToBlob(data, 'image/png');
}

// ── OpenAI backend ───────────────────────────────────────────────────────────
async function generateOpenAI(items, total, dateLabel, settings) {
  const apiKey = settings.openaiApiKey;
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', `${PROMPT}\n\nThe day is ${dateLabel}. The bold total number should read $${total.toFixed(2)}.`);
  form.append('size', '1024x1024');

  for (let i = 0; i < items.length; i++) {
    const blob = await imgToBlob(items[i].img);
    form.append('image[]', blob, `item${i}.png`);
  }

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });

  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return base64ToBlob(b64, 'image/png');
}

// ── Utilities ────────────────────────────────────────────────────────────────
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
