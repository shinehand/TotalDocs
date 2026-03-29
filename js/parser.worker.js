/**
 * parser.worker.js — HWP 파싱 Web Worker
 *
 * 파싱 로직을 메인 스레드와 분리해 UI 블로킹을 원천 차단합니다.
 * main thread ↔ Worker 통신: postMessage / onmessage
 */

try {
  importScripts('../lib/pako.min.js');
} catch (err) {
  // pako 로드에 실패하면 아래의 브라우저 기본 API fallback 을 사용합니다.
}

/* ── HWP 파서 (worker 내 독립 구현) ── */

const HWP_SIG = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];

function u16(b, o) { return (b[o] ?? 0) | ((b[o+1] ?? 0) << 8); }
function u32(b, o) {
  return ((b[o]??0)|((b[o+1]??0)<<8)|((b[o+2]??0)<<16)|((b[o+3]??0)<<24)) >>> 0;
}
function u16be(b, o) {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function u32be(b, o) {
  return (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
}

function run(text, opts) {
  return Object.assign(
    { text: text||'', bold:false, italic:false, underline:false,
      fontSize:11, fontName:'Malgun Gothic', color:'#000000' },
    opts
  );
}

function paginate(paras, n) {
  if (!paras.length) return [{ index:0, paragraphs:[] }];
  const expanded = paras.flatMap(para => (
    para.type === 'table'
      ? splitTableBlock(para, Math.max(16, n - 4))
      : [para]
  ));
  const pages = [];
  let current = [];
  let currentWeight = 0;

  for (const para of expanded) {
    const weight = Math.max(1, estimateBlockWeight(para));
    if (current.length && currentWeight + weight > n) {
      pages.push({ index: pages.length, paragraphs: current });
      current = [];
      currentWeight = 0;
    }
    current.push(para);
    currentWeight += weight;
  }

  if (current.length) {
    pages.push({ index: pages.length, paragraphs: current });
  }

  return pages;
}

/* ════════════════════════════════════════════════════════
   CFB FAT 유틸리티
════════════════════════════════════════════════════════ */

/**
 * CFB 헤더의 DIFAT 배열로부터 FAT 섹터 체인 맵을 구성합니다.
 * fat[섹터번호] = 다음 섹터번호 (0xFFFFFFFE = 끝, 0xFFFFFFFF = 미사용)
 */
function readFat(b, ss) {
  const nFat = u32(b, 0x2C);
  const entriesPerSec = ss / 4;
  const difat = [];
  for (let i = 0; i < 109 && difat.length < nFat; i++) {
    const sec = u32(b, 0x4C + i * 4);
    if (sec >= 0xFFFFFFF8) break;
    difat.push(sec);
  }

  // 일부 HWP는 csectFat가 0인데도 헤더 DIFAT에 실제 FAT 섹터를 기록합니다.
  // 이 경우 헤더 DIFAT를 기준으로 FAT를 복원해야 BodyText/Section 스트림을 찾을 수 있습니다.
  if (nFat === 0) {
    for (let i = difat.length; i < 109; i++) {
      const sec = u32(b, 0x4C + i * 4);
      if (sec >= 0xFFFFFFF8) break;
      difat.push(sec);
    }
  }

  const fatSectorCount = Math.max(nFat, difat.length);
  if (fatSectorCount === 0) return new Uint32Array(0);
  const fat = new Uint32Array(fatSectorCount * entriesPerSec);

  let difatSec = u32(b, 0x44);
  const nDifatSec = u32(b, 0x48);
  let difatRead = 0;
  const visited = new Set();
  while (difat.length < fatSectorCount && difatSec < 0xFFFFFFF8 && difatRead < nDifatSec && !visited.has(difatSec)) {
    visited.add(difatSec);
    const base = (difatSec + 1) * ss;
    if (base + ss > b.length) break;
    for (let i = 0; i < entriesPerSec - 1 && difat.length < fatSectorCount; i++) {
      const sec = u32(b, base + i * 4);
      if (sec >= 0xFFFFFFF8) continue;
      difat.push(sec);
    }
    difatSec = u32(b, base + (entriesPerSec - 1) * 4);
    difatRead++;
  }

  for (let i = 0; i < fatSectorCount; i++) {
    const fatSec = difat[i];
    if (fatSec == null) break;
    const base = (fatSec + 1) * ss;
    if (base + ss > b.length) continue;
    for (let j = 0; j < entriesPerSec; j++) {
      fat[i * entriesPerSec + j] = u32(b, base + j * 4);
    }
  }
  return fat;
}

/** FAT 체인을 따라 일반 스트림(>=miniCutoff) 데이터를 읽습니다. */
function readStreamByFat(b, startSec, streamSz, ss, fat) {
  if (startSec >= 0xFFFFFFF8 || streamSz === 0) return null;
  const result = new Uint8Array(streamSz);
  let written = 0, sec = startSec;

  while (sec < 0xFFFFFFF8 && written < streamSz) {
    const off = (sec + 1) * ss;
    const len = Math.min(ss, streamSz - written);
    if (off + len > b.length) break;
    result.set(b.subarray(off, off + len), written);
    written += len;
    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  if (written === 0) return null;
  return written === streamSz ? result : result.slice(0, written);
}

/** MiniFAT 체인을 읽어 miniFat[miniSec] = 다음 miniSec 맵을 구성합니다. */
function readMiniFat(b, ss, fat) {
  const miniFatStartSec = u32(b, 0x3C);
  const nMiniFatSec = u32(b, 0x40);
  if (nMiniFatSec === 0 || miniFatStartSec >= 0xFFFFFFFA) return new Uint32Array(0);

  const entriesPerSec = ss / 4;
  const miniFat = new Uint32Array(nMiniFatSec * entriesPerSec);
  let sec = miniFatStartSec;
  let i = 0;
  const visited = new Set();

  while (sec < 0xFFFFFFF8 && !visited.has(sec) && i < nMiniFatSec) {
    visited.add(sec);
    const base = (sec + 1) * ss;
    if (base + ss > b.length) break;
    for (let j = 0; j < entriesPerSec; j++) {
      miniFat[i * entriesPerSec + j] = u32(b, base + j * 4);
    }
    i++;
    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return miniFat;
}

/** MiniFAT 체인을 따라 미니 스트림(<miniCutoff) 데이터를 읽습니다. */
function readStreamByMiniFat(miniStream, startSec, streamSz, miniFat) {
  if (!miniStream || startSec >= 0xFFFFFFF8 || streamSz === 0) return null;
  const miniSS = 64;
  const result = new Uint8Array(streamSz);
  let written = 0, sec = startSec;
  const visited = new Set();

  while (sec < 0xFFFFFFF8 && written < streamSz && !visited.has(sec)) {
    visited.add(sec);
    const off = sec * miniSS;
    const len = Math.min(miniSS, streamSz - written);
    if (off + len > miniStream.length) break;
    result.set(miniStream.subarray(off, off + len), written);
    written += len;
    sec = (miniFat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  if (written === 0) return null;
  return written === streamSz ? result : result.slice(0, written);
}

/** 이름 목록에 해당하는 CFB 디렉토리 엔트리를 스캔합니다. */
function scanDirEntries(b, names, ss, fat, dirStartSec) {
  // 이름 → UTF-16LE 바이트 배열 + 예상 nameLen 미리 계산
  const queries = names.map(name => {
    const pat = [];
    for (const c of name) { const cc = c.charCodeAt(0); pat.push(cc & 0xFF, cc >> 8); }
    return { name, pat, nameLen: (name.length + 1) * 2 };
  });

  const result = {};
  const found = new Set();
  if (dirStartSec >= 0xFFFFFFFA) return result;

  let sec = dirStartSec;
  const visited = new Set();
  while (sec < 0xFFFFFFF8 && !visited.has(sec)) {
    visited.add(sec);
    const base = (sec + 1) * ss;
    if (base + ss > b.length) break;

    for (let pos = base; pos + 128 <= base + ss; pos += 128) {
      const nl = u16(b, pos + 64);
      for (const { name, pat, nameLen } of queries) {
        if (found.has(name)) continue;
        if (nl !== nameLen) continue;
        let ok = true;
        for (let k = 0; k < pat.length; k++) {
          if (b[pos + k] !== pat[k]) { ok = false; break; }
        }
        if (ok) {
          result[name] = {
            startSec: u32(b, pos + 116),
            streamSz: u32(b, pos + 120),
          };
          found.add(name);
        }
      }
    }

    if (found.size === queries.length) break;
    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return result;
}

function scanAllDirEntries(b, ss, fat, dirStartSec) {
  const result = {};
  if (dirStartSec >= 0xFFFFFFFA) return result;

  let sec = dirStartSec;
  const visited = new Set();
  while (sec < 0xFFFFFFF8 && !visited.has(sec)) {
    visited.add(sec);
    const base = (sec + 1) * ss;
    if (base + ss > b.length) break;

    for (let pos = base; pos + 128 <= base + ss; pos += 128) {
      const nl = u16(b, pos + 64);
      if (!nl) continue;
      const name = new TextDecoder('utf-16le')
        .decode(b.slice(pos, pos + Math.max(0, nl - 2)))
        .replace(/\u0000/g, '');
      if (!name) continue;
      result[name] = {
        startSec: u32(b, pos + 116),
        streamSz: u32(b, pos + 120),
      };
    }

    sec = (fat[sec] ?? 0xFFFFFFFE) >>> 0;
  }
  return result;
}

function readEntryStream(b, entry, ss, fat, miniCutoff, miniStream, miniFat) {
  if (!entry) return null;
  const { startSec, streamSz } = entry;
  if (streamSz < miniCutoff && miniStream) {
    return readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
  }
  return readStreamByFat(b, startSec, streamSz, ss, fat);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function detectImageMime(bytes, filename = '') {
  if (!bytes?.length) return '';
  const ext = String(filename).split('.').pop().toLowerCase();
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'webp') return 'image/webp';
  return '';
}

async function parseHwpBinaryMap(b, allEntries, ss, fat, miniCutoff, miniStream, miniFat) {
  const binEntries = Object.entries(allEntries || {})
    .filter(([name]) => /^BIN\d+\.(png|jpe?g|gif|bmp|webp)$/i.test(name))
    .sort((a, b) => {
      const ai = Number((a[0].match(/^BIN(\d+)/i) || [])[1] || 0);
      const bi = Number((b[0].match(/^BIN(\d+)/i) || [])[1] || 0);
      return ai - bi;
    });

  const images = {};
  const ordered = [];
  const byId = {};

  for (const [name, entry] of binEntries) {
    let bytes = readEntryStream(b, entry, ss, fat, miniCutoff, miniStream, miniFat);
    if (!bytes?.length) continue;

    let mime = detectImageMime(bytes, name);
    if (!mime) {
      try {
        bytes = await decompressZlib(bytes);
        mime = detectImageMime(bytes, name);
      } catch {}
    }
    if (!mime) continue;

    const src = `data:${mime};base64,${bytesToBase64(bytes)}`;
    const numericId = Number((name.match(/^BIN(\d+)/i) || [])[1] || 0);
    const imageEntry = { id: numericId, name, src };
    images[name] = src;
    ordered.push(imageEntry);
    if (numericId > 0) {
      byId[numericId] = imageEntry;
    }
  }

  return { images, ordered, byId };
}

/* ════════════════════════════════════════════════════════
   zlib 압축 해제
════════════════════════════════════════════════════════ */
async function decompressZlib(data) {
  if (typeof pako !== 'undefined') {
    try {
      return pako.inflateRaw(data);
    } catch (rawErr) {
      try {
        return pako.inflate(data);
      } catch (wrappedErr) {
        throw new Error(`zlib 압축 해제 실패: ${rawErr?.message || wrappedErr?.message || wrappedErr || rawErr}`);
      }
    }
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('압축 해제 라이브러리를 찾을 수 없습니다.');
  }

  const timeoutMs = 8000;
  let lastError = null;
  for (const mode of ['deflate', 'deflate-raw']) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`zlib 압축 해제 시간 초과 (${Math.floor(timeoutMs / 1000)}초)`)), timeoutMs);
    });

    try {
      const ds = new DecompressionStream(mode);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      const chunks = [];

      const decodePromise = (async () => {
        await writer.write(data);
        await writer.close();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      })();

      await Promise.race([decodePromise, timeoutPromise]);

      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch (e) {
      lastError = e;
      if (mode === 'deflate-raw') {
        throw new Error(`zlib 압축 해제 실패 (mode=${mode}): ${e?.message || e}`);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw new Error(`zlib 압축 해제 실패: ${lastError?.message || 'unknown error'}`);
}

/* ════════════════════════════════════════════════════════
   HWP 바이너리 레코드 파서
   TagID 66 = HWPTAG_PARA_HEADER
   TagID 67 = HWPTAG_PARA_TEXT  ← 텍스트 추출 대상
════════════════════════════════════════════════════════ */
function createParagraphBlock(text, align = 'left') {
  return {
    type: 'paragraph',
    align,
    texts: [run(text)],
  };
}

function hwpBorderTypeName(typeId) {
  switch (Number(typeId)) {
    case 0: return 'SOLID';
    case 1: return 'LONG_DASH';
    case 2: return 'DOT';
    case 3: return 'DASH_DOT';
    case 4: return 'DASH_DOT_DOT';
    case 5: return 'LONG_DASH';
    case 6: return 'DOT';
    case 7:
    case 8:
    case 9:
    case 10:
      return 'DOUBLE';
    case 11:
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
      return 'SOLID';
    default:
      return 'NONE';
  }
}

function hwpBorderWidthMm(widthId) {
  const widths = [
    0.1, 0.12, 0.15, 0.2,
    0.25, 0.3, 0.4, 0.5,
    0.6, 0.7, 1.0, 1.5,
    2.0, 3.0, 4.0, 5.0,
  ];
  return widths[Number(widthId)] || 0.1;
}

function hwpColorRefToCss(value) {
  const color = Number(value);
  if (!Number.isFinite(color)) return '';
  const r = color & 0xFF;
  const g = (color >> 8) & 0xFF;
  const b = (color >> 16) & 0xFF;
  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function i16(b, o) {
  const value = u16(b, o);
  return value > 0x7FFF ? value - 0x10000 : value;
}

function parseHwpFillInfo(body, offset = 32) {
  if (!body || offset + 4 > body.length) {
    return { fillColor: '', fillGradient: null };
  }

  const fillType = u32(body, offset);
  let pos = offset + 4;
  let fillColor = '';
  let fillGradient = null;

  if ((fillType & 0x00000001) && pos + 12 <= body.length) {
    fillColor = hwpColorRefToCss(u32(body, pos));
    pos += 12;
  }

  if ((fillType & 0x00000004) && pos + 12 <= body.length) {
    const angle = i16(body, pos + 2);
    const colorCount = Math.max(0, u16(body, pos + 10));
    pos += 12;

    if (colorCount > 2 && pos + (colorCount * 4) <= body.length) {
      pos += colorCount * 4;
    }

    const colors = [];
    for (let i = 0; i < colorCount && pos + 4 <= body.length; i++, pos += 4) {
      const color = hwpColorRefToCss(u32(body, pos));
      if (color) colors.push(color);
    }

    if (colors.length >= 2) {
      fillGradient = { type: 'LINEAR', angle, colors };
    } else if (!fillColor && colors[0]) {
      fillColor = colors[0];
    }
  }

  return { fillColor, fillGradient };
}

function parseHwpBorderFill(body) {
  if (!body || body.length < 32) return null;

  const lineTypes = [body[2], body[3], body[4], body[5]];
  const lineWidths = [body[6], body[7], body[8], body[9]];
  const lineColors = [
    u32(body, 10),
    u32(body, 14),
    u32(body, 18),
    u32(body, 22),
  ];
  const fill = parseHwpFillInfo(body, 32);
  const toBorder = index => ({
    type: hwpBorderTypeName(lineTypes[index]),
    widthMm: hwpBorderWidthMm(lineWidths[index]),
    color: hwpColorRefToCss(lineColors[index]),
  });

  return {
    left: toBorder(0),
    right: toBorder(1),
    top: toBorder(2),
    bottom: toBorder(3),
    fillColor: fill.fillColor,
    fillGradient: fill.fillGradient,
  };
}

function parseHwpFaceName(body) {
  if (!body || body.length < 3) return '';
  const nameLength = u16(body, 1);
  if (!nameLength) return '';
  const end = Math.min(body.length, 3 + (nameLength * 2));
  return new TextDecoder('utf-16le')
    .decode(body.slice(3, end))
    .replace(/\u0000/g, '')
    .trim();
}

function parseHwpCharShape(body, faceNames = {}) {
  if (!body || body.length < 56) return null;
  const attr = u32(body, 46);
  const faceId = u16(body, 0);
  const fontSizeRaw = u32(body, 42);
  return {
    fontName: faceNames[faceId] || '',
    fontSize: fontSizeRaw > 0 ? Math.round((fontSizeRaw / 100) * 10) / 10 : 0,
    color: hwpColorRefToCss(u32(body, 52)),
    bold: Boolean(attr & (1 << 1)),
    italic: Boolean(attr & 1),
    underline: ((attr >> 2) & 0x3) !== 0,
  };
}

function hwpAlignFromAttr(attr) {
  switch ((Number(attr) >> 2) & 0x7) {
    case 0: return 'justify';
    case 1: return 'left';
    case 2: return 'right';
    case 3: return 'center';
    case 4:
    case 5:
      return 'justify';
    default:
      return 'left';
  }
}

function i32(b, o) {
  const value = u32(b, o);
  return value > 0x7FFFFFFF ? value - 0x100000000 : value;
}

function parseHwpParaShape(body) {
  if (!body || body.length < 26) return null;
  const attr = u32(body, 0);
  const modernLineSpacing = body.length >= 54 ? u32(body, 50) : 0;
  const legacyLineSpacing = body.length >= 28 ? u32(body, 24) : 0;
  return {
    align: hwpAlignFromAttr(attr),
    marginLeft: i32(body, 4),
    textIndent: i32(body, 12),
    spacingBefore: i32(body, 16),
    spacingAfter: i32(body, 20),
    lineSpacing: modernLineSpacing || legacyLineSpacing || 0,
  };
}

function parseHwpParaHeader(body) {
  if (!body || body.length < 18) {
    return { paraShapeId: 0, charShapes: [] };
  }
  return {
    paraShapeId: u16(body, 8),
    styleId: body[10] ?? 0,
    splitFlags: body[11] ?? 0,
    charShapeCount: u16(body, 12),
    charShapes: [],
  };
}

function parseHwpParaCharShape(body) {
  const ranges = [];
  if (!body || body.length < 8) return ranges;

  for (let offset = 0; offset + 8 <= body.length; offset += 8) {
    ranges.push({
      start: u32(body, offset),
      charShapeId: u32(body, offset + 4),
    });
  }

  return ranges;
}

function parseHwpParaLineSeg(body) {
  const segments = [];
  if (!body || body.length < 36) return segments;

  for (let offset = 0; offset + 36 <= body.length; offset += 36) {
    const height = i32(body, offset + 8);
    const textHeight = i32(body, offset + 12);
    const lineSpacing = i32(body, offset + 20);
    if (height <= 0 && textHeight <= 0) continue;
    segments.push({
      height,
      textHeight,
      lineSpacing,
    });
  }

  return segments;
}

function hwpCellVerticalAlign(listFlags) {
  switch ((Number(listFlags) >> 5) & 0x3) {
    case 1: return 'middle';
    case 2: return 'bottom';
    default: return 'top';
  }
}

function summarizeHwpLineSegs(lineSegs = []) {
  const saneSegs = lineSegs.filter(seg => {
    const height = Math.max(Number(seg?.height) || 0, Number(seg?.textHeight) || 0);
    return height >= 400 && height <= 6000;
  });
  if (!saneSegs.length) {
    return { lineHeightPx: 0, layoutHeightPx: 0 };
  }

  const heights = saneSegs.map(seg => Math.max(Number(seg.height) || 0, Number(seg.textHeight) || 0));
  const totalHeight = heights.reduce((sum, value) => sum + value, 0);
  const avgHeight = totalHeight / heights.length;
  return {
    lineHeightPx: Math.max(11, Math.min(42, Math.round(avgHeight / 106))),
    layoutHeightPx: Math.max(12, Math.min(320, Math.round(totalHeight / 106))),
  };
}

function buildHwpTextRuns(text, charShapes = [], docInfo = null) {
  const sourceText = String(text || '');
  const normalizedRanges = Array.isArray(charShapes)
    ? charShapes
      .filter(range => Number.isFinite(range?.start) && Number.isFinite(range?.charShapeId))
      .sort((a, b) => a.start - b.start)
    : [];

  if (!normalizedRanges.length) {
    return [run(sourceText)];
  }

  if (normalizedRanges[0].start !== 0) {
    normalizedRanges.unshift({
      start: 0,
      charShapeId: normalizedRanges[0].charShapeId,
    });
  }

  const runs = [];
  for (let i = 0; i < normalizedRanges.length; i++) {
    const current = normalizedRanges[i];
    const nextStart = i + 1 < normalizedRanges.length
      ? normalizedRanges[i + 1].start
      : sourceText.length;
    const safeStart = Math.max(0, Math.min(sourceText.length, current.start));
    const safeEnd = Math.max(safeStart, Math.min(sourceText.length, nextStart));
    const runText = sourceText.slice(safeStart, safeEnd);
    if (!runText && sourceText.length) continue;
    runs.push(run(runText, docInfo?.charShapes?.[current.charShapeId] || {}));
  }

  return runs.length ? runs : [run(sourceText)];
}

function createHwpParagraphBlock(text, paraState = {}, docInfo = null) {
  const paraStyle = docInfo?.paraShapes?.[paraState?.paraShapeId] || null;
  const lineMetrics = summarizeHwpLineSegs(paraState?.lineSegs || []);
  return {
    type: 'paragraph',
    align: paraStyle?.align || 'left',
    marginLeft: paraStyle?.marginLeft ?? 0,
    textIndent: paraStyle?.textIndent ?? 0,
    spacingBefore: paraStyle?.spacingBefore ?? 0,
    spacingAfter: paraStyle?.spacingAfter ?? 0,
    lineSpacing: paraStyle?.lineSpacing ?? 0,
    lineHeightPx: lineMetrics.lineHeightPx,
    layoutHeightPx: lineMetrics.layoutHeightPx,
    texts: buildHwpTextRuns(text, paraState?.charShapes || [], docInfo),
  };
}

function parseHwpDocInfoRecords(data) {
  const faceNames = {};
  const borderFills = {};
  const charShapes = {};
  const paraShapes = {};
  let faceNameId = 1;
  let borderFillId = 1;
  let charShapeId = 1;
  let paraShapeId = 1;
  let pos = 0;

  while (pos < data.length) {
    const rec = readRecord(data, pos);
    if (!rec) break;
    if (rec.tagId === 19) {
      const faceName = parseHwpFaceName(rec.body);
      if (faceName) {
        faceNames[faceNameId] = faceName;
      }
      faceNameId += 1;
      pos = rec.nextPos;
      continue;
    }
    if (rec.tagId === 20) {
      const borderFill = parseHwpBorderFill(rec.body);
      if (borderFill) {
        borderFills[borderFillId] = borderFill;
      }
      borderFillId += 1;
      pos = rec.nextPos;
      continue;
    }
    if (rec.tagId === 21) {
      const charShape = parseHwpCharShape(rec.body, faceNames);
      if (charShape) {
        charShapes[charShapeId] = charShape;
      }
      charShapeId += 1;
      pos = rec.nextPos;
      continue;
    }
    if (rec.tagId === 25) {
      const paraShape = parseHwpParaShape(rec.body);
      if (paraShape) {
        paraShapes[paraShapeId] = paraShape;
      }
      paraShapeId += 1;
    }
    pos = rec.nextPos;
  }

  return {
    faceNames,
    borderFills,
    charShapes,
    paraShapes,
    faceNameCount: faceNameId - 1,
    borderFillCount: borderFillId - 1,
    charShapeCount: charShapeId - 1,
    paraShapeCount: paraShapeId - 1,
  };
}

async function parseHwpDocInfoStream(data, compressedHint) {
  const attempts = [{ mode: 'raw', bytes: data }];
  try {
    attempts.push({ mode: 'deflated', bytes: await decompressZlib(data) });
  } catch (e) {
    if (compressedHint) {
      console.warn('[Worker] DocInfo 압축 해제 실패:', e.message);
    }
  }

  let best = {
    faceNames: {},
    borderFills: {},
    charShapes: {},
    paraShapes: {},
    faceNameCount: 0,
    borderFillCount: 0,
    charShapeCount: 0,
    paraShapeCount: 0,
  };
  let bestMode = 'raw';
  for (const attempt of attempts) {
    if (!attempt.bytes?.length) continue;
    const parsed = parseHwpDocInfoRecords(attempt.bytes);
    const score = (parsed.faceNameCount || 0)
      + (parsed.borderFillCount || 0)
      + (parsed.charShapeCount || 0)
      + (parsed.paraShapeCount || 0);
    const bestScore = (best.faceNameCount || 0)
      + (best.borderFillCount || 0)
      + (best.charShapeCount || 0)
      + (best.paraShapeCount || 0);
    if (score > bestScore) {
      best = parsed;
      bestMode = attempt.mode;
    }
  }

  if ((best.borderFillCount || 0) > 0 || (best.charShapeCount || 0) > 0 || (best.paraShapeCount || 0) > 0) {
    self.postMessage({
      type: 'progress',
      msg: `DocInfo borderFill ${best.borderFillCount || 0}개, 글자모양 ${best.charShapeCount || 0}개, 문단모양 ${best.paraShapeCount || 0}개 적용 (${bestMode})`,
    });
  }

  return best;
}

function nextHwpBinaryImage(docInfo = null) {
  if (!docInfo?.binImages?.length) return null;
  const index = docInfo.binImageCursor || 0;
  const image = docInfo.binImages[index] || null;
  if (image) {
    docInfo.binImageCursor = index + 1;
  }
  return image;
}

function parseHwpPictureBinId(pictureBody, docInfo = null) {
  if (!pictureBody || pictureBody.length < 72) return 0;

  const candidates = [
    u32be(pictureBody, 68),
    u16be(pictureBody, 70),
    pictureBody[71] || 0,
  ].filter(value => Number.isFinite(value) && value > 0);

  if (docInfo?.binImagesById) {
    const matched = candidates.find(value => docInfo.binImagesById[value]);
    if (matched) return matched;
  }

  return candidates[0] || 0;
}

function resolveHwpBinaryImage(docInfo = null, pictureBody = null) {
  const binId = parseHwpPictureBinId(pictureBody, docInfo);
  if (binId > 0 && docInfo?.binImagesById?.[binId]) {
    return docInfo.binImagesById[binId];
  }
  return nextHwpBinaryImage(docInfo);
}

function pickHwpDisplayMetric(...candidates) {
  const positives = candidates
    .map(value => Number(value) || 0)
    .filter(value => value > 0);
  if (!positives.length) return 0;
  return Math.min(...positives);
}

function firstPositiveMetric(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate) || 0;
    if (value > 0) return value;
  }
  return 0;
}

function parseHwpGsoBlock(ctrlBody, pictureBody, docInfo = null) {
  if (!pictureBody?.length) return null;
  const imageRef = resolveHwpBinaryImage(docInfo, pictureBody);
  if (!imageRef?.src) return null;

  const width = firstPositiveMetric(
    u32(ctrlBody, 16),
    u32(pictureBody, 52),
    u32(pictureBody, 20),
    u32(pictureBody, 28),
    0,
  );
  const height = firstPositiveMetric(
    u32(ctrlBody, 20),
    u32(pictureBody, 56),
    u32(pictureBody, 32),
    u32(pictureBody, 40),
    0,
  );

  return {
    type: 'image',
    src: imageRef.src,
    alt: imageRef.name || 'image',
    width,
    height,
    align: 'left',
    inline: false,
    offsetX: 0,
    offsetY: 0,
    sourceFormat: 'hwp',
  };
}

function parseGsoControl(data, startPos, ctrlLevel, ctrlBody, docInfo = null) {
  let pos = startPos;
  let pictureBody = null;

  while (pos < data.length) {
    const rec = readRecord(data, pos);
    if (!rec) break;
    if (rec.level <= ctrlLevel) break;
    if (rec.tagId === 85 && !pictureBody) {
      pictureBody = rec.body;
    }
    pos = rec.nextPos;
  }

  return {
    block: parseHwpGsoBlock(ctrlBody, pictureBody, docInfo),
    nextPos: pos,
  };
}

function readRecord(data, pos) {
  if (pos + 4 > data.length) return null;

  const hdr = u32(data, pos);
  pos += 4;

  const tagId = hdr & 0x3FF;
  const level = (hdr >> 10) & 0x3FF;
  let size = (hdr >> 20) & 0xFFF;

  if (size === 0xFFF) {
    if (pos + 4 > data.length) return null;
    size = u32(data, pos);
    pos += 4;
  }

  const end = Math.min(pos + size, data.length);
  return {
    tagId,
    level,
    size,
    startPos: pos,
    nextPos: end,
    body: data.subarray(pos, end),
  };
}

function ctrlId(body) {
  if (!body || body.length < 4) return '';
  return String.fromCharCode(body[3], body[2], body[1], body[0]);
}

function skipControlSubtree(data, startPos, ctrlLevel) {
  let pos = startPos;
  while (pos < data.length) {
    const rec = readRecord(data, pos);
    if (!rec) break;
    if (rec.level <= ctrlLevel) break;
    pos = rec.nextPos;
  }
  return pos;
}

function parseTableInfo(body) {
  if (!body || body.length < 18) return null;

  const rowCount = u16(body, 4);
  const colCount = u16(body, 6);
  const cellSpacing = u16(body, 8);
  const rowHeights = [];

  let off = 18;
  for (let i = 0; i < rowCount && off + 2 <= body.length; i++, off += 2) {
    rowHeights.push(u16(body, off));
  }

  return {
    rowCount,
    colCount,
    cellSpacing,
    rowHeights,
  };
}

function parseTableCell(body) {
  if (!body || body.length < 34) return null;
  const listFlags = u32(body, 2);

  return {
    paragraphCount: Math.max(0, u16(body, 0)),
    listFlags,
    verticalAlign: hwpCellVerticalAlign(listFlags),
    col: u16(body, 8),
    row: u16(body, 10),
    colSpan: Math.max(1, u16(body, 12)),
    rowSpan: Math.max(1, u16(body, 14)),
    width: u32(body, 16),
    height: u32(body, 20),
    padding: [
      u16(body, 24),
      u16(body, 26),
      u16(body, 28),
      u16(body, 30),
    ],
    borderFillId: u16(body, 32),
    paragraphs: [],
  };
}

function cellText(cell) {
  if (!cell?.paragraphs?.length) return '';
  return cell.paragraphs
    .map(block => blockText(block))
    .filter(Boolean)
    .join('\n');
}

function blockText(block) {
  if (!block) return '';

  if (block.type === 'table') {
    return (block.rows || [])
      .map(row => (row.cells || []).map(cell => cellText(cell)).join(' '))
      .join('\n');
  }

  return (block.texts || []).map(chunk => chunk.text || '').join('');
}

function estimateBlockWeight(block) {
  if (!block) return 1;
  if (block.type === 'table') {
    return (block.rows || []).reduce(
      (sum, row) => sum + tableRowWeight(block, row.index),
      0,
    );
  }
  return 1;
}

function tableRowWeight(tableBlock, rowIndex) {
  const rowHeight = tableBlock?.rowHeights?.[rowIndex];
  return Math.max(1, rowHeight || 4);
}

function isSafeTableBreak(tableBlock, rowIndex) {
  return !(tableBlock.rows || []).some(row => (row.cells || []).some(cell => (
    cell.row <= rowIndex && (cell.row + cell.rowSpan - 1) > rowIndex
  )));
}

function sliceTableBlock(tableBlock, startRow, endRow) {
  const rows = Array.from({ length: endRow - startRow }, (_, index) => ({ index, cells: [] }));
  const sourceRows = (tableBlock.rows || []).slice(startRow, endRow);

  sourceRows.forEach((sourceRow, offset) => {
    (sourceRow.cells || []).forEach(cell => {
      const nextCell = {
        ...cell,
        row: cell.row - startRow,
        paragraphs: [...(cell.paragraphs || [])],
      };
      rows[offset].cells.push(nextCell);
    });
  });

  return {
    ...tableBlock,
    rowCount: rows.length,
    rows,
    rowHeights: (tableBlock.rowHeights || []).slice(startRow, endRow),
    estimatedParagraphs: rows.reduce(
      (sum, row) => sum + row.cells.reduce(
        (cellSum, cell) => cellSum + Math.max(1, (cell.paragraphs || []).length),
        0,
      ),
      0,
    ),
    texts: [run('')],
  };
}

function splitTableBlock(tableBlock, maxWeight) {
  if (tableBlock.type !== 'table' || tableBlock.rowCount <= 1) {
    return [tableBlock];
  }

  const chunks = [];
  let startRow = 0;

  while (startRow < tableBlock.rowCount) {
    let endRow = startRow;
    let weight = 0;
    let lastSafeBreak = -1;

    while (endRow < tableBlock.rowCount) {
      weight += tableRowWeight(tableBlock, endRow);
      if (isSafeTableBreak(tableBlock, endRow)) {
        lastSafeBreak = endRow + 1;
      }
      endRow += 1;

      if (weight >= maxWeight && lastSafeBreak > startRow) {
        endRow = lastSafeBreak;
        break;
      }
    }

    if (endRow <= startRow) {
      endRow = startRow + 1;
    }

    chunks.push(sliceTableBlock(tableBlock, startRow, endRow));
    startRow = endRow;
  }

  return chunks;
}

function buildTableBlock(tableInfo, cells) {
  if (!cells.length) return null;

  const rowCount = Math.max(
    tableInfo?.rowCount || 0,
    ...cells.map(cell => cell.row + cell.rowSpan),
  );
  const colCount = Math.max(
    tableInfo?.colCount || 0,
    ...cells.map(cell => cell.col + cell.colSpan),
  );

  const columnWidths = Array.from({ length: colCount }, () => 0);
  const sortedCells = cells
    .filter(cell => cell.col < colCount && cell.row < rowCount)
    .sort((a, b) => (a.row - b.row) || (a.col - b.col));

  for (const cell of sortedCells) {
    const unitWidth = cell.width > 0 ? cell.width / Math.max(1, cell.colSpan) : 0;
    for (let c = cell.col; c < Math.min(colCount, cell.col + cell.colSpan); c++) {
      columnWidths[c] = Math.max(columnWidths[c], unitWidth);
    }
  }

  if (!columnWidths.some(Boolean)) {
    columnWidths.fill(1);
  }

  const rows = Array.from({ length: rowCount }, (_, index) => ({ index, cells: [] }));
  for (const cell of sortedCells) {
    rows[cell.row].cells.push(cell);
  }

  const estimatedParagraphs = cells.reduce(
    (sum, cell) => sum + Math.max(1, cell.paragraphs.length),
    0,
  );

  return {
    type: 'table',
    align: 'left',
    rowCount,
    colCount,
    rows,
    columnWidths,
    cellSpacing: tableInfo?.cellSpacing || 0,
    rowHeights: tableInfo?.rowHeights || [],
    estimatedParagraphs,
    texts: [run('')],
  };
}

function parseTableControl(data, startPos, ctrlLevel, docInfo = null) {
  let pos = startPos;
  let tableInfo = null;
  const cells = [];

  while (pos < data.length) {
    const rec = readRecord(data, pos);
    if (!rec) break;
    if (rec.level <= ctrlLevel) break;

    if (rec.level === ctrlLevel + 1 && rec.tagId === 77) {
      tableInfo = parseTableInfo(rec.body);
      pos = rec.nextPos;
      continue;
    }

    if (rec.level === ctrlLevel + 1 && rec.tagId === 72) {
      const cell = parseTableCell(rec.body);
      pos = rec.nextPos;

      if (!cell) continue;

      const paragraphs = [];
      let currentText = null;
      let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
      const pushParagraph = () => {
        if (currentText === null) return;
        paragraphs.push(createHwpParagraphBlock(currentText, currentParaState, docInfo));
        currentText = null;
        currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
      };

      while (pos < data.length) {
        const next = readRecord(data, pos);
        if (!next) break;
        if (next.level <= ctrlLevel) break;
        if (next.level === ctrlLevel + 1 && next.tagId === 72) break;

        if (next.tagId === 71) {
          const nestedCtrlId = ctrlId(next.body);
          if (nestedCtrlId === 'tbl ') {
            pushParagraph();
            const { block, nextPos } = parseTableControl(data, next.nextPos, next.level, docInfo);
            if (block) paragraphs.push(block);
            pos = nextPos;
            continue;
          }
          if (nestedCtrlId === 'gso ') {
            pushParagraph();
            const { block, nextPos } = parseGsoControl(data, next.nextPos, next.level, next.body, docInfo);
            if (block) paragraphs.push(block);
            pos = nextPos;
            continue;
          }
          pos = skipControlSubtree(data, next.nextPos, next.level);
          continue;
        }

        if (next.level === ctrlLevel + 1 && next.tagId === 66) {
          pushParagraph();
          currentText = '';
          currentParaState = parseHwpParaHeader(next.body);
          currentParaState.lineSegs = [];
          pos = next.nextPos;
          continue;
        }

        if (next.tagId === 68) {
          currentParaState.charShapes = parseHwpParaCharShape(next.body);
          pos = next.nextPos;
          continue;
        }

        if (next.tagId === 69) {
          currentParaState.lineSegs = parseHwpParaLineSeg(next.body);
          pos = next.nextPos;
          continue;
        }

        if (next.tagId === 67) {
          if (currentText === null) currentText = '';
          currentText += decodeParaText(next.body, 0, next.body.length);
        }

        pos = next.nextPos;
      }

      pushParagraph();
      if (!paragraphs.length) {
        paragraphs.push(createParagraphBlock(''));
      }

      cell.paragraphs = paragraphs;
      cell.borderStyle = docInfo?.borderFills?.[cell.borderFillId] || null;
      cells.push(cell);
      continue;
    }

    pos = rec.nextPos;
  }

  return {
    block: buildTableBlock(tableInfo, cells),
    nextPos: pos,
  };
}

function parseHwpRecords(data, docInfo = null, extras = null) {
  return parseHwpBlockRange(data, 0, docInfo, null, extras).blocks;
}

function parseHwpBlockRange(data, startPos = 0, docInfo = null, stopLevel = null, extras = null) {
  const paras = [];
  let pos = startPos;
  let currentText = null;
  let currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
  const pushParagraph = () => {
    if (currentText === null) return;
    paras.push(createHwpParagraphBlock(currentText, currentParaState, docInfo));
    currentText = null;
    currentParaState = { paraShapeId: 0, charShapes: [], lineSegs: [] };
  };

  while (pos < data.length) {
    const rec = readRecord(data, pos);
    if (!rec) break;
    if (stopLevel !== null && rec.level <= stopLevel) break;

    if (rec.tagId === 71) {
      const controlId = ctrlId(rec.body);
      if (controlId === 'tbl ') {
        pushParagraph();
        const { block, nextPos } = parseTableControl(data, rec.nextPos, rec.level, docInfo);
        if (block) paras.push(block);
        pos = nextPos;
        continue;
      }
      if (controlId === 'gso ') {
        pushParagraph();
        const { block, nextPos } = parseGsoControl(data, rec.nextPos, rec.level, rec.body, docInfo);
        if (block) paras.push(block);
        pos = nextPos;
        continue;
      }
      if (controlId === 'head' || controlId === 'foot') {
        pushParagraph();
        const subtree = parseHwpBlockRange(data, rec.nextPos, docInfo, rec.level, null);
        const target = controlId === 'head' ? extras?.headerBlocks : extras?.footerBlocks;
        if (target && subtree.blocks.length) {
          target.push(...subtree.blocks);
        }
        pos = subtree.nextPos;
        continue;
      }

      pushParagraph();
      const subtree = parseHwpBlockRange(data, rec.nextPos, docInfo, rec.level, null);
      if (subtree.blocks.length) {
        paras.push(...subtree.blocks);
        pos = subtree.nextPos;
        continue;
      }
      pos = skipControlSubtree(data, rec.nextPos, rec.level);
      continue;
    }

    if (rec.tagId === 66) {
      pushParagraph();
      currentText = '';
      currentParaState = parseHwpParaHeader(rec.body);
      currentParaState.lineSegs = [];
      pos = rec.nextPos;
      continue;
    }

    if (rec.tagId === 68) {
      currentParaState.charShapes = parseHwpParaCharShape(rec.body);
      pos = rec.nextPos;
      continue;
    }

    if (rec.tagId === 69) {
      currentParaState.lineSegs = parseHwpParaLineSeg(rec.body);
      pos = rec.nextPos;
      continue;
    }

    if (rec.tagId === 67 && rec.size >= 2) {
      if (currentText === null) currentText = '';
      currentText += decodeParaText(rec.body, 0, rec.body.length);
    }

    pos = rec.nextPos;
  }

  pushParagraph();
  return { blocks: paras, nextPos: pos };
}

function isInlineOrExtendedControl(ch) {
  return (
    ch === 0x0001 ||
    ch === 0x0002 ||
    (ch >= 0x0003 && ch <= 0x0009) ||
    (ch >= 0x000B && ch <= 0x0017)
  );
}

function decodeParaText(data, start, end) {
  const chars = [];
  let i = start;

  while (i + 2 <= end) {
    const ch = data[i] | (data[i + 1] << 8);

    if (ch === 0x000D) {
      i += 2;
      break;
    }

    if (ch === 0x0009) {
      chars.push('\t');
      i += 16;
      continue;
    }

    if (ch === 0x000A) {
      chars.push('\n');
      i += 2;
      continue;
    }

    if (ch === 0x0018) {
      chars.push('-');
      i += 2;
      continue;
    }

    if (ch === 0x001E || ch === 0x001F) {
      chars.push(' ');
      i += 2;
      continue;
    }

    if (isInlineOrExtendedControl(ch)) {
      i += 16;
      continue;
    }

    if (ch >= 0x0020) chars.push(String.fromCharCode(ch));
    i += 2;
  }

  return chars.join('');
}

function scoreParas(paras) {
  return paras.reduce((sum, para) => (
    sum + blockText(para).replace(/\s+/g, '').length
  ), 0);
}

function paragraphsFromText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\x02/g, '\n')
    .split('\n')
    .map(line => createParagraphBlock(line));
}

/**
 * BodyText 구조 레코드가 깨졌을 때 UTF-16LE 텍스트 덩어리를 휴리스틱하게 복구합니다.
 * 한글이 1글자 이상 포함된 연속 블록을 우선 선택해 바이너리 노이즈보다 실제 본문 후보를 고릅니다.
 */
function scanUtf16TextBlock(data, startOffset = 0, minRawLen = 20) {
  let bestStart = -1, bestScore = 0, bestRawLen = 0;
  let runStart = -1, runLen = 0, koreanInRun = 0;

  const isValidCp = cp =>
    (cp >= 0x20  && cp <= 0x7E)   ||
    (cp >= 0xAC00 && cp <= 0xD7A3)||
    (cp >= 0x1100 && cp <= 0x11FF)||
    (cp >= 0x3130 && cp <= 0x318F)||
    (cp >= 0x4E00 && cp <= 0x9FFF)||
    cp === 0x000A || cp === 0x000D || cp === 0x0009 || cp === 0x0002;

  const flush = () => {
    if (runLen >= minRawLen && koreanInRun > 0) {
      const score = runLen * (1 + koreanInRun / Math.max(runLen / 2, 1));
      if (score > bestScore) {
        bestStart = runStart;
        bestScore = score;
        bestRawLen = runLen;
      }
    }
    runStart = -1;
    runLen = 0;
    koreanInRun = 0;
  };

  for (let i = startOffset; i + 2 <= data.length; i += 2) {
    const cp = data[i] | (data[i + 1] << 8);
    if (isValidCp(cp)) {
      if (runStart < 0) runStart = i;
      runLen += 2;
      if (cp >= 0xAC00 && cp <= 0xD7A3) koreanInRun++;
    } else {
      flush();
    }
  }
  flush();

  if (bestStart < 0) return null;
  return new TextDecoder('utf-16le').decode(data.slice(bestStart, bestStart + bestRawLen));
}

/**
 * 섹션 스트림을 raw/deflated 양쪽으로 구조 파싱하고, 모두 실패하면 UTF-16 텍스트 블록 복구까지 시도합니다.
 * 그래도 본문 후보가 없을 때만 빈 결과를 반환해 상위 단계가 PrvText fallback 으로 넘어가게 합니다.
 */
async function extractSectionParas(data, compressedHint, sectionName, docInfo = null) {
  const attempts = [];
  const pushAttempt = (mode, bytes) => {
    if (!bytes || bytes.length === 0) return;
    attempts.push({ mode, bytes });
  };

  if (compressedHint) {
    try {
      pushAttempt('deflated', await decompressZlib(data));
    } catch (e) {
      console.warn(`[Worker] ${sectionName} 압축 해제 실패:`, e.message);
      pushAttempt('raw', data);
    }
  } else {
    pushAttempt('raw', data);
    try {
      pushAttempt('deflated', await decompressZlib(data));
    } catch {}
  }

  let bestParas = [];
  let bestHeaderBlocks = [];
  let bestFooterBlocks = [];
  let bestScore = 0;

  for (const { mode, bytes } of attempts) {
    const extras = { headerBlocks: [], footerBlocks: [] };
    const paras = parseHwpRecords(bytes, docInfo, extras);
    const score = scoreParas(paras);
    if (score > bestScore) {
      bestScore = score;
      bestParas = paras;
      bestHeaderBlocks = extras.headerBlocks;
      bestFooterBlocks = extras.footerBlocks;
    }
    if (score > 0) {
      self.postMessage({ type: 'progress', msg: `${sectionName}: ${paras.length}개 단락 완료 (${mode})` });
    }
  }

  if (bestScore > 0) {
    return {
      paras: bestParas,
      headerBlocks: bestHeaderBlocks,
      footerBlocks: bestFooterBlocks,
    };
  }

  for (const { mode, bytes } of attempts) {
    const text = scanUtf16TextBlock(bytes, 0, 20);
    if (!text) continue;
      const paras = paragraphsFromText(text);
      const score = scoreParas(paras);
      if (score > 0) {
        self.postMessage({ type: 'progress', msg: `${sectionName}: 텍스트 블록 복구 (${mode})` });
        return { paras, headerBlocks: [], footerBlocks: [] };
      }
    }

  return { paras: [], headerBlocks: [], footerBlocks: [] };
}

/* ════════════════════════════════════════════════════════
   전략 0: BodyText/Section 스트림 직접 파싱 (최우선)
════════════════════════════════════════════════════════ */
async function parseBodyText(b) {
  self.postMessage({ type: 'progress', msg: 'BodyText 섹션 탐색 중...' });

  const ss          = (() => { const e = u16(b, 0x1E); return (e>=7&&e<=14)?(1<<e):512; })();
  const miniCutoff  = u32(b, 0x38) || 4096;
  const dirStartSec = u32(b, 0x30);
  if (dirStartSec >= 0xFFFFFFFA) return null;

  const dirBase         = (dirStartSec + 1) * ss;
  const rootStartSec    = u32(b, dirBase + 116);
  const rootStreamSz    = u32(b, dirBase + 120);
  const miniContainerOff = rootStartSec < 0xFFFFFFFA ? (rootStartSec + 1) * ss : -1;

  const fat = readFat(b, ss);
  const miniFat = readMiniFat(b, ss, fat);
  const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
    ? readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
    : null;

  // 우선 자주 쓰는 구간(Section0~9)만 빠르게 스캔
  let sectionNames = Array.from({ length: 10 }, (_, i) => 'Section' + i);
  let entries = scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
  // 9번 섹션까지 존재하면 그때만 확장 스캔
  if (entries.Section9) {
    sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
    entries = scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
  }

  // FileHeader → 압축/암호화 플래그 확인
  let compressed = true;
  if (entries.FileHeader) {
    const { startSec, streamSz } = entries.FileHeader;
    let fhData;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      fhData = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      fhData = readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (fhData && fhData.length >= 40) {
      compressed = (fhData[36] & 1) !== 0;
      const encrypted = (fhData[36] & 2) !== 0;
      if (encrypted) {
        self.postMessage({ type: 'progress', msg: '암호화된 문서입니다 — 복호화 불가' });
        return null;
      }
    }
  }

  const docInfoEntry = entries.DocInfo;
  let docInfo = { borderFills: {}, borderFillCount: 0 };
  if (docInfoEntry) {
    const { startSec, streamSz } = docInfoEntry;
    let docInfoData;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      docInfoData = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      docInfoData = readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (docInfoData?.length) {
      docInfo = await parseHwpDocInfoStream(docInfoData, compressed);
    }
  }

  const allEntries = scanAllDirEntries(b, ss, fat, dirStartSec);
  const hwpImages = await parseHwpBinaryMap(b, allEntries, ss, fat, miniCutoff, miniStream, miniFat);
  docInfo.images = hwpImages.images;
  docInfo.binImages = hwpImages.ordered;
  docInfo.binImagesById = hwpImages.byId;
  docInfo.binImageCursor = 0;

  let sectionNumbers = Object.keys(entries)
    .filter(name => /^Section\d+$/.test(name))
    .map(name => Number(name.slice(7)))
    .sort((a, b) => a - b);
  if (sectionNumbers.length === 0 && !entries.Section9) {
    sectionNames = Array.from({ length: 100 }, (_, i) => 'Section' + i);
    entries = scanDirEntries(b, ['FileHeader', 'DocInfo', ...sectionNames], ss, fat, dirStartSec);
    sectionNumbers = Object.keys(entries)
      .filter(name => /^Section\d+$/.test(name))
      .map(name => Number(name.slice(7)))
      .sort((a, b) => a - b);
  }

  // Section 파싱
  const allParas = [];
  let headerBlocks = [];
  let footerBlocks = [];
  for (const sn of sectionNumbers) {
    const entry = entries['Section' + sn];
    if (!entry) continue;

    const { startSec, streamSz } = entry;
    if (startSec >= 0xFFFFFFFA || streamSz === 0) continue;

    self.postMessage({ type: 'progress', msg: `Section${sn} 읽는 중... (${(streamSz/1024).toFixed(0)} KB)` });

    let data;
    if (streamSz < miniCutoff && miniContainerOff > 0) {
      data = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
    } else {
      data = readStreamByFat(b, startSec, streamSz, ss, fat);
    }
    if (!data || data.length === 0) continue;

    const parsed = await extractSectionParas(data, compressed, 'Section' + sn, docInfo);
    allParas.push(...(parsed?.paras || []));
    if (!headerBlocks.length && parsed?.headerBlocks?.length) {
      headerBlocks = parsed.headerBlocks;
    }
    if (!footerBlocks.length && parsed?.footerBlocks?.length) {
      footerBlocks = parsed.footerBlocks;
    }
  }

  return allParas.length > 0 ? {
    paragraphs: allParas,
    headerBlocks,
    footerBlocks,
  } : null;
}

/* ════════════════════════════════════════════════════════
   전략 1: CFB PrvText 스트림 추출
════════════════════════════════════════════════════════ */
function scanPrvText(b) {
  const exp  = u16(b, 0x1E);
  const ss   = (exp >= 7 && exp <= 14) ? (1 << exp) : 512;
  const miniCutoff = u32(b, 0x38) || 4096;

  const dirStartSec = u32(b, 0x30);
  if (dirStartSec >= 0xFFFFFFFA) return null;
  const dirBase = (dirStartSec + 1) * ss;
  if (dirBase + 128 > b.length) return null;

  const rootStartSec = u32(b, dirBase + 116);
  const rootStreamSz = u32(b, dirBase + 120);
  const miniContainerOff = (rootStartSec < 0xFFFFFFFA) ? (rootStartSec + 1) * ss : -1;
  const fat = readFat(b, ss);
  const miniFat = readMiniFat(b, ss, fat);
  const miniStream = (rootStartSec < 0xFFFFFFFA && rootStreamSz > 0)
    ? readStreamByFat(b, rootStartSec, rootStreamSz, ss, fat)
    : null;

  self.postMessage({ type:'progress', msg:`PrvText CFB 스캔 중... ss=${ss}` });
  const entries = scanDirEntries(b, ['PrvText'], ss, fat, dirStartSec);
  const prv = entries.PrvText;
  if (!prv) return null;

  const { startSec, streamSz } = prv;
  if (startSec >= 0xFFFFFFFA || streamSz === 0 || streamSz > 8 * 1024 * 1024) return null;

  let raw;
  if (streamSz < miniCutoff && miniContainerOff > 0) {
    raw = readStreamByMiniFat(miniStream, startSec, streamSz, miniFat);
  } else {
    raw = readStreamByFat(b, startSec, streamSz, ss, fat);
  }
  if (!raw || raw.length === 0) return null;

  const text = new TextDecoder('utf-16le').decode(raw);
  let korean = 0, printable = 0;
  for (const c of text) {
    const cp = c.charCodeAt(0);
    if (cp >= 0xAC00 && cp <= 0xD7A3) { korean++; printable++; }
    else if (cp >= 0x20 || cp === 10 || cp === 13) printable++;
  }
  if (text.length === 0 || printable / text.length < 0.6 || korean < 3) return null;

  self.postMessage({ type:'progress', msg:`PrvText 추출 성공 (${text.length}글자)` });
  return text;
}

/* ════════════════════════════════════════════════════════
   전략 2: 한글 UTF-16LE 블록 직접 스캔
════════════════════════════════════════════════════════ */
function scanKoreanText(b) {
  self.postMessage({ type:'progress', msg:'한글 텍스트 직접 스캔 중...' });

  const isValid = cp =>
    (cp >= 0x20  && cp <= 0x7E)    ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0x1100 && cp <= 0x11FF) ||
    (cp >= 0x3130 && cp <= 0x318F) ||
    cp === 10 || cp === 13 || cp === 9 || cp === 2;

  let bestStart = -1, bestScore = 0, bestRawLen = 0;
  let runStart  = -1, runLen = 0, koreanInRun = 0;

  const flush = () => {
    if (runLen >= 100 && koreanInRun >= runLen / 10) {
      const score = runLen * (koreanInRun / (runLen / 2));
      if (score > bestScore) {
        bestStart = runStart; bestScore = score; bestRawLen = runLen;
      }
    }
    runStart = -1; runLen = 0; koreanInRun = 0;
  };

  for (let i = 512; i + 2 <= b.length; i += 2) {
    const cp = b[i] | (b[i+1] << 8);
    if (isValid(cp)) {
      if (runStart < 0) runStart = i;
      runLen += 2;
      if (cp >= 0xAC00 && cp <= 0xD7A3) koreanInRun++;
    } else { flush(); }
  }
  flush();

  if (bestStart < 0) return null;
  const text = new TextDecoder('utf-16le').decode(b.slice(bestStart, bestStart + bestRawLen));
  self.postMessage({ type:'progress', msg:`한글 스캔 성공 (${text.length}글자)` });
  return text;
}

/* ════════════════════════════════════════════════════════
   HWPX (ZIP + XML) 파싱
════════════════════════════════════════════════════════ */
async function parseHwpx(buffer) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip을 Worker에서 사용할 수 없습니다. 메인 스레드에서 파싱합니다.');
  }
  const zip   = await JSZip.loadAsync(buffer);
  const keys  = Object.keys(zip.files)
    .filter(p => /Contents[\\/]section\d+\.xml$/i.test(p)).sort();
  if (!keys.length) throw new Error('HWPX: 섹션 없음');

  const pages = [];
  for (let i = 0; i < keys.length; i++) {
    const xml  = await zip.files[keys[i]].async('string');
    const doc  = new DOMParser().parseFromString(xml, 'application/xml');
    const ps   = Array.from(doc.querySelectorAll('p'));
    const paras = ps.length
      ? ps.map(p => ({ align: p.getAttribute('align')||'left', texts:[run(p.textContent||'')] }))
      : [{ align:'left', texts:[run(doc.documentElement.textContent.trim())] }];
    pages.push({ index: i, paragraphs: paras });
  }
  return { meta:{ pages:pages.length }, pages };
}

/* ════════════════════════════════════════════════════════
   메시지 수신 → 파싱 실행
════════════════════════════════════════════════════════ */
self.onmessage = async ({ data }) => {
  const { buffer, filename } = data;
  const ext = filename.split('.').pop().toLowerCase();

  try {
    let doc;

    if (ext === 'hwpx') {
      try {
        importScripts('../lib/jszip.min.js');
        doc = await parseHwpx(buffer);
      } catch(e) {
        self.postMessage({ type:'fallback_main', reason: e.message });
        return;
      }
    } else {
      // HWP 5.0
      const b = new Uint8Array(buffer);
      if (!HWP_SIG.every((v,i) => b[i] === v)) {
        throw new Error('HWP 시그니처 불일치');
      }

      // ── 전략 0: BodyText/Section 스트림 파싱 (전체 텍스트 + 단락 구조) ──
      let parsedBody = null;
      try {
        parsedBody = await parseBodyText(b);
      } catch(e) {
        console.warn('[Worker] BodyText 파싱 실패:', e.message);
      }

      if (parsedBody?.paragraphs?.length) {
        // 빈 단락 정리 (연속 빈 줄 2개 초과 → 1개로 압축)
        const cleaned = [];
        let emptyRun = 0;
        for (const p of parsedBody.paragraphs) {
          const isEmpty = !blockText(p).trim();
          if (isEmpty) { if (++emptyRun <= 2) cleaned.push(p); }
          else { emptyRun = 0; cleaned.push(p); }
        }
        const pages = paginate(cleaned, 48);
        if (pages.length) {
          if (parsedBody.headerBlocks?.length) {
            pages[0].headerBlocks = parsedBody.headerBlocks;
          }
          if (parsedBody.footerBlocks?.length) {
            pages[0].footerBlocks = parsedBody.footerBlocks;
          }
        }
        doc = { meta: { pages: pages.length }, pages };
        self.postMessage({ type: 'done', doc });
        return;
      }

      // ── 전략 1: PrvText ──
      let text = null;
      try { text = scanPrvText(b); }     catch(e) { console.warn(e); }

      // ── 전략 2: 한글 블록 스캔 ──
      if (!text) {
        try { text = scanKoreanText(b); } catch(e) { console.warn(e); }
      }

      if (!text) {
        doc = {
          meta: { pages:1, note:'파싱 실패' },
          pages:[{ index:0, paragraphs:[{ align:'center', texts:[run(
            '⚠️ 이 HWP 파일의 텍스트를 추출하지 못했습니다.\n\n' +
            '해결책: 한글에서 "다른 이름으로 저장 → HWPX" 후 재시도하세요.'
          )] }] }]
        };
      } else {
        const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\x02/g,'\n').split('\n');
        const paras = lines.map(line => createParagraphBlock(line));
        const pages = paginate(paras, 35);
        doc = { meta:{ pages:pages.length, note:'⚠️ PrvText 텍스트 추출 (서식 미지원)' }, pages };
      }
    }

    self.postMessage({ type:'done', doc });

  } catch(err) {
    self.postMessage({ type:'error', message: err.message });
  }
};
