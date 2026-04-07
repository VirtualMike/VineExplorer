# Vine Explorer — Tampermonkey Userscript Plan

## Context
Amazon Vine participants need better browsing tools: inline ETV visibility, full-text search across titles and descriptions, keyword watchlists with notifications, a favorites list, automated background category scanning, and heat-map reporting on when items are released. The solution must run in-browser (Tampermonkey) so timing naturally matches real user behavior, minimizing Amazon ban risk.

---

## Platform & Storage
- **Tampermonkey userscript** (`@match https://www.amazon.com/vine/*`)
- **IndexedDB** for persistent local storage
- Background scanning via direct **Vine API calls** (fetch with session cookies already present) — no extra tabs needed, cleaner and more controllable

---

## IndexedDB Schema

### `products` store (keyPath: `asin`)
| Field | Type | Notes |
|---|---|---|
| asin | string | PK |
| title | string | |
| vendor | string | |
| description | string | |
| etv | number\|null | |
| imageUrl | string | |
| hasOptions | bool | |
| category | string | Category slug |
| available | bool | |
| firstSeen | timestamp | |
| lastChecked | timestamp | |
| removedAt | timestamp\|null | |

### `keywords` store (keyPath: `id`, autoIncrement)
| Field | Type |
|---|---|
| keyword | string |
| createdAt | timestamp |

### `favorites` store (keyPath: `asin`)
| Field | Type | Notes |
|---|---|---|
| asin | string | |
| addedAt | timestamp | |
| matchedKeyword | string\|null | |

### `scan_history` store (keyPath: `id`, autoIncrement)
| Field | Type | Notes |
|---|---|---|
| timestamp | number | Unix ms |
| hourOfDay | number | 0–23 |
| category | string | Category slug or "all" |
| itemCount | number | Total items seen this scan |
| newItems | number | Delta from previous scan |
| removedItems | number | Items no longer present |

---

## Script Module Structure

```
vine-explorer.user.js
├── METADATA BLOCK         @match, @grant
├── db.js (inline)         IndexedDB: products, keywords, favorites, scan_history
├── vineApi.js (inline)    Authenticated fetch to Vine API, pagination, category list
├── scanner.js (inline)    Background scan scheduler, category queue, hourly/overnight logic
├── etvFetcher.js          ETV fetch via detail panel simulation, human delay
├── overlay.js (inline)    ETV badges, filter/sort bar, keyword highlights, star icon
├── notifications.js       GM_notification toasts with product link + auto-favorite
├── favorites.js           Floating favorites drawer
├── heatmap.js             Canvas-based heat map chart (items released by hour)
├── settings.js            Modal: keywords, purge, scan schedule, DB stats, heat map tab
└── main.js (inline)       Init, MutationObserver, scheduler wiring
```

---

## Category Scan Order
Vine categories scanned in this order (automotive always last to avoid long waits disrupting other useful categories):

```
Electronics → Computers → Home & Kitchen → Tools & Home Improvement →
Kitchen & Dining → Garden & Outdoor → Toys & Games → Sports & Outdoors →
Health & Household → Beauty & Personal Care → Baby → Pet Supplies →
Office Products → Musical Instruments → Arts & Crafts → Books →
Clothing → Shoes → Automotive
```

Categories stored as config (editable in settings). User can reorder or disable any.

---

## Background Scanning Strategy

### How it works
- Uses `fetch()` against the Vine recommendations API (`/vine/api/recommendations?queue=potluck&...`) with the user's existing session cookies — no browser navigation required.
- Pagination: follow `paginationToken` until exhausted for full category scan.
- New products saved to DB; delta (newItems) recorded in `scan_history`.

### Scan schedules

| Schedule | Trigger | Behavior |
|---|---|---|
| **Full category scan** | User-initiated or daily at midnight | All categories in order, automotive last. ~3–8s delay between page fetches. |
| **Hourly quick scan** | Every 60 min (setInterval + time check) | Scans first 2–3 pages of potluck + top categories only. Records delta. |
| **Overnight aggressive scan** | 1:00 AM – 8:00 AM local time | Scans frequently (every 15 min) on pages where new products typically land (potluck, encore, last_chance). Records per-scan delta. |

### Human-like API pacing
```js
// Between paginated API calls within same category:
await humanDelay(3000, 8000);
// Between categories:
await humanDelay(10000, 25000);
// Overnight scans (less conservative, still safe):
await humanDelay(8000, 15000);
```

---

## Heat Map Reporting

### Data collected
Every scan writes a `scan_history` record including `hourOfDay` and `newItems`. Over time this builds a statistical picture of when Amazon loads new Vine products.

### Heat map display
- Canvas-based chart rendered in the Settings modal → **Reports tab**.
- X-axis: hours 0–23.
- Y-axis: average `newItems` per scan at that hour (rolling 30-day window).
- Color scale: cool (blue) = few items → warm (orange/red) = many items.
- Secondary view: stacked by category to show which categories are most active at each hour.
- Tooltip on hover: exact average + scan count for that hour.

---

## Key Features

### Overlay on Vine Page
- **ETV badge**: Injected per card, shown as `ETV: $XX.XX` or `ETV: fetching…`
- **Control bar**: Above product grid — filter by ETV range, keyword match, favorites only; sort by ETV/title/date
- **Keyword highlight**: Colored border + keyword pill on matching products
- **Star icon**: Manual favorite toggle on each card

### ETV Fetching
- Simulates clicking "See details" button on each card
- `humanDelay(2000, 6000)` between each click
- Max 5 ETVs per batch, then 10–20s pause
- Prioritizes items visible in viewport

### Keyword Watchlist & Notifications
- Check all new products from each scan against keyword list (title + description, case-insensitive)
- On match: `GM_notification` toast with product title, clicking opens product URL
- Auto-add matched products to favorites with `matchedKeyword` tagged

### Favorites Panel
- Floating right-side drawer (toggle button)
- Shows: thumbnail, title, ETV, matched keyword tag, product link, remove button
- Sorted newest first

### Settings Modal (gear button, bottom-right)
Tabs:
- **Keywords**: Add/remove, live-test against sample product
- **Categories**: Reorder, enable/disable, view last scan time per category
- **Schedule**: Enable/disable hourly scan, overnight scan window (default 1–8 AM)
- **Database**: Product count, removed count, last full scan time; "Purge removed" button
- **Reports**: Heat map chart with 30-day rolling window

---

## Availability Checker
- On script init, products not checked in >7 days are queued
- Attempts to verify each via Vine API or product page fetch
- Marks `available=false` + `removedAt` on 404 / "unavailable" response
- Throttled: 1 check per 30 seconds, only when tab is active

---

## File to Create
| Path | Description |
|---|---|
| `vine-explorer.user.js` | Single self-contained Tampermonkey script (~1000–1500 lines) |

---

## Implementation Order
1. Metadata block + IndexedDB module (all stores including `scan_history`)
2. Vine API client (`vineApi.js`) — authenticated fetch, pagination, category list
3. Background scanner + scheduler (hourly, overnight, full scan)
4. Heat map data recording (writes to `scan_history` each scan)
5. ETV fetcher (simulated clicks, human delay)
6. Overlay: badges, control bar, keyword highlights, star icon
7. Keyword engine + GM_notification toasts + auto-favorites
8. Favorites drawer UI
9. Settings modal (all tabs including heat map chart)
10. Availability checker
11. CSS polish via `GM_addStyle`

---

## Verification
1. Install Tampermonkey; add script.
2. Navigate to `https://www.amazon.com/vine/vine-items?queue=potluck`.
3. Confirm overlay renders: ETV badges appear with delay; control bar shows.
4. Add keyword matching a visible product → toast fires, product appears in favorites.
5. Open Settings → Categories → trigger manual scan → confirm `scan_history` records appear.
6. Open Settings → Reports → confirm heat map renders with data points.
7. Check DevTools Network — API calls have ≥3s gaps; no rapid bursts.
8. Set system clock to 2 AM (or mock `Date`) → confirm overnight scan triggers.
