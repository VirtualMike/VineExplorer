// lib/xlsx.js — dependency-free XLSX reader for Vine Explorer
// XLSX is a ZIP of DEFLATE-compressed XML parts. We use the browser-native
// DecompressionStream('deflate-raw') (Chrome 103+) — no third-party library,
// no eval/WASM (MV3 CSP-safe).
//
// Public API:
//   parseXlsx(bytes) -> { headers: string[], rows: Array<Record<string,string|number>> }
//
// Assumptions specific to the Amazon Vine itemized report, made robust where cheap:
//   - Reads the first worksheet (xl/worksheets/sheet1.xml)
//   - Detects the header row automatically (first row with >1 non-empty cell)
//   - Maps cells by column letter (rows are sparse — blank cells are omitted)

const textDecoder = new TextDecoder('utf-8');

// ── ZIP reading ───────────────────────────────────────────────────────────
// Minimal reader using the End Of Central Directory record + central directory.
// Handles STORED (method 0) and DEFLATE (method 8) entries.

async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEOCD(view, bytes.length);
  if (eocd < 0) throw new Error('Not a valid ZIP (no EOCD)');

  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset     = view.getUint32(eocd + 16, true);

  const files = {};
  for (let i = 0; i < entryCount; i++) {
    // Central directory file header signature 0x02014b50
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;

    const method       = view.getUint16(cdOffset + 10, true);
    const compSize      = view.getUint32(cdOffset + 20, true);
    const nameLen      = view.getUint16(cdOffset + 28, true);
    const extraLen     = view.getUint16(cdOffset + 30, true);
    const commentLen   = view.getUint16(cdOffset + 32, true);
    const localOffset  = view.getUint32(cdOffset + 42, true);

    const name = textDecoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));

    files[name] = { method, compSize, localOffset };
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    async read(name) {
      const entry = files[name];
      if (!entry) return null;

      // Parse the local file header to find where the data actually starts
      // (local header extra-field length can differ from the central one).
      const lh = entry.localOffset;
      if (view.getUint32(lh, true) !== 0x04034b50) throw new Error('Bad local header for ' + name);
      const lhNameLen  = view.getUint16(lh + 26, true);
      const lhExtraLen = view.getUint16(lh + 28, true);
      const dataStart  = lh + 30 + lhNameLen + lhExtraLen;
      const compData   = bytes.subarray(dataStart, dataStart + entry.compSize);

      if (entry.method === 0) return compData;            // STORED
      if (entry.method === 8) return inflateRaw(compData); // DEFLATE
      throw new Error('Unsupported ZIP compression method ' + entry.method);
    },
    names: Object.keys(files)
  };
}

function findEOCD(view, len) {
  // EOCD signature 0x06054b50, scan backwards from end (comment is usually empty)
  const minPos = Math.max(0, len - 65_557); // 22 byte record + max 65535 comment
  for (let pos = len - 22; pos >= minPos; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) return pos;
  }
  return -1;
}

async function inflateRaw(compBytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(compBytes).body.pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ── XML parsing ─────────────────────────────────────────────────────────────
// The two report parts (sharedStrings, sheet1) are parsed with targeted regex,
// NOT DOMParser — this is intentional so the module runs unchanged in the
// service worker (which has no DOMParser). The report is machine-generated and
// its structure is stable, so regex parsing is safe here.

function parseSharedStrings(xml) {
  // Each <si> is one string; it may contain multiple <t> runs (rich text).
  const strings = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRegex.exec(xml)) !== null) {
    const runs = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    const text = runs.map(r => r.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/, '$1')).join('');
    strings.push(decodeXmlEntities(text));
  }
  return strings;
}

function parseSheet(xml, sharedStrings) {
  // Returns rows as { [colLetter]: value }.
  const rows = [];
  const rowRegex = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRegex.exec(xml)) !== null) {
    const rowNum = parseInt(rm[1], 10);
    const cells  = {};

    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cellRegex.exec(rm[2])) !== null) {
      const attrs = cm[1] ?? cm[3] ?? '';
      const inner = cm[2] ?? '';
      const ref   = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!ref) continue;
      const col  = ref[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];

      const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const raw    = vMatch ? vMatch[1] : '';

      let value;
      if (type === 's') {
        value = sharedStrings[parseInt(raw, 10)] ?? '';
      } else if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = t ? decodeXmlEntities(t[1]) : '';
      } else if (type === 'n' || type === undefined) {
        value = raw === '' ? '' : Number(raw);
      } else {
        value = decodeXmlEntities(raw);
      }
      cells[col] = value;
    }
    rows.push({ rowNum, cells });
  }
  return rows;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // must be last
}

// ── Public API ────────────────────────────────────────────────────────────

export async function parseXlsx(bytes) {
  const zip = await readZip(bytes);

  const sheetBytes = await zip.read('xl/worksheets/sheet1.xml');
  if (!sheetBytes) throw new Error('xl/worksheets/sheet1.xml not found');
  const sheetXml = textDecoder.decode(sheetBytes);

  const ssBytes = await zip.read('xl/sharedStrings.xml');
  const sharedStrings = ssBytes ? parseSharedStrings(textDecoder.decode(ssBytes)) : [];

  const rawRows = parseSheet(sheetXml, sharedStrings);

  // Detect header row: first row with more than one non-empty cell.
  let headerIdx = -1;
  for (let i = 0; i < rawRows.length; i++) {
    const nonEmpty = Object.values(rawRows[i].cells).filter(v => v !== '' && v != null);
    if (nonEmpty.length > 1) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { headers: [], rows: [] };

  const headerCells = rawRows[headerIdx].cells;
  const colOrder    = Object.keys(headerCells).sort(compareCols);
  const headers     = colOrder.map(c => String(headerCells[c]).trim());

  const rows = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const cells = rawRows[i].cells;
    if (Object.keys(cells).length === 0) continue; // skip blank rows
    const obj = {};
    for (let j = 0; j < colOrder.length; j++) {
      obj[headers[j]] = cells[colOrder[j]] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows };
}

// Compare Excel column letters (A, B, ..., Z, AA, AB, ...) by their numeric value.
function compareCols(a, b) {
  return colToNum(a) - colToNum(b);
}

function colToNum(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}
