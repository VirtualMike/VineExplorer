// db/db.js — IndexedDB module for Vine Explorer
// Runs at the extension's origin (service worker, popup, options, compact view)

const DB_NAME = 'VineExplorer';
const DB_VERSION = 3;

export const STORES = {
  PRODUCTS:   'products',
  KEYWORDS:   'keywords',
  SCAN_STATE: 'scanState'
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db          = event.target.result;
      const oldVersion  = event.oldVersion;
      const transaction = event.target.transaction;

      if (oldVersion < 1) {
        const ps = db.createObjectStore(STORES.PRODUCTS, { keyPath: 'asin' });
        ps.createIndex('available',     'available',     { unique: false });
        ps.createIndex('dateFirstSeen', 'dateFirstSeen', { unique: false });
        ps.createIndex('etv',           'etv',           { unique: false });
        ps.createIndex('removedDate',   'removedDate',   { unique: false });

        const ks = db.createObjectStore(STORES.KEYWORDS, { keyPath: 'id', autoIncrement: true });
        ks.createIndex('keyword', 'keyword', { unique: true });
      }

      if (oldVersion < 2) {
        const ps = transaction.objectStore(STORES.PRODUCTS);
        if (!ps.indexNames.contains('productSiteLaunchDate')) {
          ps.createIndex('productSiteLaunchDate', 'productSiteLaunchDate', { unique: false });
        }
      }

      if (oldVersion < 3) {
        db.createObjectStore(STORES.SCAN_STATE, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Products ────────────────────────────────────────────────────────────────

export async function upsertProduct(product) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRODUCTS, 'readwrite');
    const store = tx.objectStore(STORES.PRODUCTS);
    const getReq = store.get(product.asin);

    getReq.onsuccess = () => {
      const existing = getReq.result;
      const now = Date.now();

      const record = {
        asin:          product.asin,
        title:         product.title         ?? existing?.title         ?? '',
        description:   product.description   ?? existing?.description   ?? '',
        etv:           product.etv           !== undefined ? product.etv : (existing?.etv ?? null),
        hasOptions:    product.hasOptions    !== undefined ? product.hasOptions : (existing?.hasOptions ?? false),
        vendor:        product.vendor        ?? existing?.vendor        ?? '',
        imageUrl:      product.imageUrl      ?? existing?.imageUrl      ?? '',
        category:      product.category      ?? existing?.category      ?? '',
        dateFirstSeen: existing?.dateFirstSeen ?? now,
        dateLastSeen:  now,
        available:     product.available !== undefined ? product.available : (existing?.available ?? true),
        removedDate:   product.available === false
                         ? (existing?.removedDate ?? now)
                         : null,
        productSiteLaunchDate: product.productSiteLaunchDate ?? existing?.productSiteLaunchDate ?? null,
        limitedQuantity:       product.limitedQuantity      ?? existing?.limitedQuantity      ?? false,
        encorePageFirstSeen:   existing?.encorePageFirstSeen ?? product.encorePageFirstSeen ?? null,
        keywordsMatched: product.keywordsMatched ?? existing?.keywordsMatched ?? []
      };

      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror  = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

export async function getProduct(asin) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.PRODUCTS, 'readonly');
    const req = tx.objectStore(STORES.PRODUCTS).get(asin);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function getAllProducts({ includeRemoved = false } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.PRODUCTS, 'readonly');
    const req = tx.objectStore(STORES.PRODUCTS).getAll();
    req.onsuccess = () => {
      const results = includeRemoved
        ? req.result
        : req.result.filter(p => p.available !== false);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getProductCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.PRODUCTS, 'readonly');
    const req = tx.objectStore(STORES.PRODUCTS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function markProductUnavailable(asin) {
  const db = await openDB();
  const existing = await getProduct(asin);
  if (!existing) return null;

  const record = { ...existing, available: false, removedDate: existing.removedDate ?? Date.now() };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.PRODUCTS, 'readwrite');
    const req = tx.objectStore(STORES.PRODUCTS).put(record);
    req.onsuccess = () => resolve(record);
    req.onerror   = () => reject(req.error);
  });
}

export async function purgeRemovedProducts(olderThanDays = 30) {
  const db     = await openDB();
  const cutoff = Date.now() - olderThanDays * 86_400_000;

  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORES.PRODUCTS, 'readwrite');
    const store = tx.objectStore(STORES.PRODUCTS);
    const req   = store.getAll();
    let deleted = 0;

    req.onsuccess = () => {
      req.result
        .filter(p => !p.available && p.removedDate && p.removedDate < cutoff)
        .forEach(p => { store.delete(p.asin); deleted++; });
      tx.oncomplete = () => resolve(deleted);
    };

    req.onerror = () => reject(req.error);
  });
}

export async function searchProducts(query, { includeRemoved = false, minEtv, maxEtv, keywordsOnly } = {}) {
  const all = await getAllProducts({ includeRemoved });
  const lq  = query.trim().toLowerCase();

  return all.filter(p => {
    if (lq) {
      const inTitle = p.title.toLowerCase().includes(lq);
      const inDesc  = p.description.toLowerCase().includes(lq);
      if (!inTitle && !inDesc) return false;
    }

    if (minEtv !== undefined && minEtv !== '' && (p.etv === null || p.etv < +minEtv)) return false;
    if (maxEtv !== undefined && maxEtv !== '' && (p.etv === null || p.etv > +maxEtv)) return false;

    if (keywordsOnly) {
      if (!p.keywordsMatched || p.keywordsMatched.length === 0) return false;
    }

    return true;
  });
}

// ── Keywords ─────────────────────────────────────────────────────────────────

export async function getKeywords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.KEYWORDS, 'readonly');
    const req = tx.objectStore(STORES.KEYWORDS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function addKeyword(keyword) {
  const db = await openDB();
  const kw = keyword.toLowerCase().trim();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.KEYWORDS, 'readwrite');
    const req = tx.objectStore(STORES.KEYWORDS).add({ keyword: kw, dateAdded: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteKeyword(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.KEYWORDS, 'readwrite');
    const req = tx.objectStore(STORES.KEYWORDS).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Scan State ──────────────────────────────────────────────────────────────

const DEFAULT_SCAN_STATE = {
  key:             'currentScan',
  status:          'idle',      // idle | running | paused
  scanningTabId:   null,
  currentQueue:    null,
  currentPage:     1,
  totalPages:      null,
  lastActivity:    null,
  completedQueues: []
};

export async function getScanState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.SCAN_STATE, 'readonly');
    const req = tx.objectStore(STORES.SCAN_STATE).get('currentScan');
    req.onsuccess = () => resolve(req.result ?? { ...DEFAULT_SCAN_STATE });
    req.onerror   = () => reject(req.error);
  });
}

export async function updateScanState(patch) {
  const db       = await openDB();
  const existing = await getScanState();
  const record   = { ...existing, ...patch, key: 'currentScan' };
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORES.SCAN_STATE, 'readwrite');
    const req = tx.objectStore(STORES.SCAN_STATE).put(record);
    req.onsuccess = () => resolve(record);
    req.onerror   = () => reject(req.error);
  });
}

export async function resetScanState() {
  return updateScanState({ ...DEFAULT_SCAN_STATE });
}
