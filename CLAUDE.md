# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VineExplorer is a **Chrome Extension (Manifest V3)** for Amazon Vine participants. It scrapes product data from the Vine catalog, stores it in a local IndexedDB database, and provides enhanced browsing with keyword alerts and ETV (Estimated Taxable Value) auto-discovery.

## Development Setup

**No build process required.** This is vanilla JavaScript with no bundler, no package manager, and no external dependencies.

To load the extension locally:
1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select the `VineExplorer/` directory
3. Navigate to `https://www.amazon.com/vine/vine-items?queue=potluck` to activate the content script

After editing any file, click the **reload** button on the extension card at `chrome://extensions`.

## Architecture

The extension follows a hub-and-spoke message-passing architecture:

```
Content Script ──(chrome.runtime.sendMessage)──> Service Worker ──> IndexedDB
     ↑                                                  ↓
  Vine page                                   Keyword matching & notifications
```

### Component Roles

- **`background/service-worker.js`** — Central hub. Routes all messages, owns all database operations and keyword matching. Runs as an MV3 service worker (can be killed and restarted by Chrome).

- **`content/content.js`** — Injected into `amazon.com/vine/vine-items*`. Scrapes product tiles, drives the auto-fetch queue (systematically opens ETV modals with randomized delays to avoid rate limiting), and applies inline UI enhancements (badges, keyword highlights).

- **`db/db.js`** — IndexedDB abstraction with two stores: `products` (keyed by `asin`) and `keywords` (autoincrement id). All DB calls are async. This module is imported directly by the service worker.

- **`compact/compact.js`** — Full-page product table view opened via `chrome.runtime.getURL`. Sends `GET_ALL_PRODUCTS` to the service worker on load and handles all filtering/sorting client-side.

- **`popup/popup.js`** and **`options/options.js`** — Thin UI layers that communicate with the service worker via `sendMessage`.

### Message Protocol

All inter-component communication uses `chrome.runtime.sendMessage`. The service worker dispatches on `request.type`:

| Type | Purpose |
|---|---|
| `SAVE_PRODUCT` | Upsert product (title, description, ETV, vendor, image, asin) |
| `GET_PRODUCT` / `GET_ALL_PRODUCTS` / `SEARCH_PRODUCTS` | Read product data |
| `GET_KEYWORDS` / `ADD_KEYWORD` / `DELETE_KEYWORD` | Keyword management |
| `GET_STATS` | Aggregate counts (total, available, with ETV, removed) |
| `MARK_UNAVAILABLE` / `PURGE_REMOVED` | Lifecycle maintenance |
| `OPEN_COMPACT` | Opens the compact view tab |
| `REQUEST_RESCRAPE` | Triggers periodic availability recheck |

### Service Worker Resilience

Because MV3 service workers can be terminated at any time, the content script includes retry logic (4 retries, 300ms delay) for all `sendMessage` calls to handle cold starts.

## Key Patterns

### Auto-Fetch Queue
The content script builds a queue of tiles missing ETV data, then sequentially clicks each "Details" button, waits for the ETV modal, handles product variation selection, reads the ETV value, closes the modal, and advances to the next item. Delays between queue steps are randomized (500–4000ms) to mimic human behavior and avoid Amazon rate limiting.

### Availability Tracking
- Products seen during scraping have `dateLastSeen` updated on every visit
- `MARK_UNAVAILABLE` is called for products no longer appearing in the catalog
- A 30-minute periodic alarm (`chrome.alarms`) triggers a background availability recheck
- `PURGE_REMOVED` deletes products older than a configurable age threshold

### Dynamic Content Detection
The content script uses `MutationObserver` to detect newly loaded tiles as the user scrolls (infinite scroll / pagination). It also monitors for the ETV detail panel modal opening/closing.

### Styling Conventions
All extension-injected CSS classes use the `ve-` prefix (e.g., `ve-badge`, `ve-keyword-match`) to avoid collisions with Amazon's styles.
