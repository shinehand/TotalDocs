/**
 * hwp-wasm-renderer.js — HWP 엔진 WASM 기반 Canvas 렌더링 브리지
 *
 * MIT License: Based on Edward Kim's open-source HWP engine work.
 *
 * 이 모듈은 ES module로 로드됩니다 (viewer.html에서 <script type="module">).
 * 초기화 후 window.HwpWasmRenderer 를 통해 일반 스크립트에서도 접근 가능합니다.
 *
 * 의존: lib/hwp.js, lib/hwp_bg.wasm, js/font_substitution.js
 */

// ─── LRU measureTextWidth 캐시 (기준 편집기 방식) ───
// WASM layout.rs의 estimate_text_width() / compute_char_positions()가 이 함수를 호출한다.
// 256 엔트리 LRU 캐시로 중복 측정을 방지한다.
if (typeof globalThis.measureTextWidth === 'undefined') {
  let _ctx = null;
  let _lastFont = '';
  const _cache = new Map();
  const MAX_CACHE = 2048;
  const EVICT_COUNT = 400; // 약 20% 퇴거

  globalThis.measureTextWidth = function(font, text) {
    const key = font + '\0' + text;

    if (_cache.has(key)) {
      const val = _cache.get(key);
      _cache.delete(key);
      _cache.set(key, val); // MRU로 이동
      return val;
    }

    if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
    const resolvedFont = globalThis.FontSubstitution?.substituteCssFont
      ? globalThis.FontSubstitution.substituteCssFont(font, 0, 0)
      : font;
    if (resolvedFont !== _lastFont) { _ctx.font = resolvedFont; _lastFont = resolvedFont; }

    const width = _ctx.measureText(text).width;

    if (_cache.size >= MAX_CACHE) {
      const iter = _cache.keys();
      for (let i = 0; i < EVICT_COUNT; i++) {
        const k = iter.next().value;
        if (k !== undefined) _cache.delete(k);
      }
    }
    _cache.set(key, width);
    return width;
  };
}

import initWasm, { HwpDocument, version as engineVersion } from '../lib/hwp.js';

let _initialized = false;
let _initPromise = null;

// 현재 로드된 문서 (zoom 재렌더 위해 doc 유지)
let _currentDoc = null;
let _pageTextLayoutCache = new Map();
let _pageInfoCache = new Map();
let _pageControlLayoutCache = new Map();

function clearPageLayoutCache() {
  _pageTextLayoutCache = new Map();
}

function clearRuntimeCaches() {
  clearPageLayoutCache();
  _pageInfoCache = new Map();
  _pageControlLayoutCache = new Map();
}

function parseJsonSafely(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * WASM 모듈을 초기화한다 (최초 1회만 실행).
 */
async function ensureInit() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = initWasm().then(() => {
    _initialized = true;
    console.log(`[HWP 엔진] 초기화 완료 v${engineVersion()}`);
  });
  return _initPromise;
}

/**
 * HWP/HWPX 바이너리를 WASM으로 Canvas에 렌더링하여 페이지별 canvas 배열을 반환한다.
 * 폰트 로드 완료를 기다린 후 렌더링하여 정확한 텍스트 레이아웃을 보장한다.
 *
 * @param {ArrayBuffer} buffer — HWP/HWPX 파일 바이너리
 * @param {number} [zoom=1.0] — 줌 배율
 * @returns {Promise<{pageCount: number, pages: Array<{canvas: HTMLCanvasElement, width: number, height: number, index: number}>, docInfo: object}>}
 */
async function renderDocument(buffer, zoom = 1.0) {
  await ensureInit();

  // 폰트 프리로드 완료 대기 (viewer.html의 globalThis._fontLoadPromise)
  if (globalThis._fontLoadPromise) {
    try { await globalThis._fontLoadPromise; } catch (e) { /* 폰트 실패해도 계속 */ }
  }

  // 이전 문서 해제
  if (_currentDoc) {
    try { _currentDoc.free(); } catch (e) { /* ignore */ }
    _currentDoc = null;
  }

  const data = new Uint8Array(buffer);
  const doc = new HwpDocument(data);
  doc.convertToEditable(); // 배포용(읽기전용) 문서 자동 변환
  _currentDoc = doc;
  clearRuntimeCaches();

  return _renderAllPages(zoom);
}

/**
 * 현재 로드된 문서를 새 줌 배율로 재렌더링한다.
 * @param {number} zoom — 줌 배율
 */
async function rerenderAtZoom(zoom) {
  if (!_currentDoc) return null;
  await ensureInit();
  return _renderAllPages(zoom);
}

/**
 * 현재 문서의 모든 페이지를 Canvas로 렌더링한다.
 * @param {number} zoom
 */
function _renderAllPages(zoom) {
  const doc = _currentDoc;
  const pageCount = doc.pageCount();
  const pages = [];

  // 문서 정보
  let docInfo = {};
  try { docInfo = JSON.parse(doc.getDocumentInfo()); } catch (e) { /* ignore */ }

  for (let i = 0; i < pageCount; i++) {
    const canvas = document.createElement('canvas');
    doc.renderPageToCanvas(i, canvas, zoom);

    // 이미지 데이터 재렌더 (비동기 이미지 디코딩 대응)
    // 첫 번째(200ms), 두 번째(700ms), 세 번째(1800ms) 총 3회 재렌더하여
    // JPEG/PNG 임베드 이미지가 디코딩 완료된 뒤 캔버스에 반영되도록 한다.
    const capturedI = i;
    const capturedCanvas = canvas;
    const _rerender = () => {
      if (_currentDoc === doc) {
        try { doc.renderPageToCanvas(capturedI, capturedCanvas, zoom); } catch (e) { /* ignore */ }
      }
    };
    setTimeout(_rerender, 200);
    setTimeout(_rerender, 700);
    setTimeout(_rerender, 1800);

    pages.push({
      canvas,
      width: canvas.width,
      height: canvas.height,
      index: i,
    });
  }

  return { pageCount, pages, docInfo };
}

const MAX_SEARCH_ITERATIONS = 10000; // 검색 결과 최대 순회 횟수

function findQueryOffsets(text, query, caseSensitive = false) {
  if (!text || !query) return [];

  const haystack = Array.from(caseSensitive ? text : text.toLocaleLowerCase());
  const needle = Array.from(caseSensitive ? query : query.toLocaleLowerCase());
  if (!needle.length || haystack.length < needle.length) return [];

  const offsets = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        matched = false;
        break;
      }
    }
    if (matched) offsets.push(start);
  }
  return offsets;
}

function findWhitespaceInsensitiveOffsets(text, query, caseSensitive = false) {
  if (!text || !query) return [];
  if (/\s/.test(query) || !/\s/.test(text)) return [];

  const sourceChars = Array.from(caseSensitive ? text : text.toLocaleLowerCase());
  const queryChars = Array.from(caseSensitive ? query : query.toLocaleLowerCase()).filter(char => !/\s/.test(char));
  if (!queryChars.length) return [];

  const compactChars = [];
  const compactToOriginal = [];

  for (let i = 0; i < sourceChars.length; i += 1) {
    if (/\s/.test(sourceChars[i])) continue;
    compactChars.push(sourceChars[i]);
    compactToOriginal.push(i);
  }

  if (compactChars.length < queryChars.length) return [];

  const matches = [];
  for (let start = 0; start <= compactChars.length - queryChars.length; start += 1) {
    let matched = true;
    for (let i = 0; i < queryChars.length; i += 1) {
      if (compactChars[start + i] !== queryChars[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const originalStart = compactToOriginal[start];
    const originalEnd = compactToOriginal[start + queryChars.length - 1] + 1;
    matches.push({ start: originalStart, end: originalEnd });
  }

  return matches;
}

function getPageOfPosition(sectionIndex, paragraphIndex) {
  if (!_currentDoc) return null;
  try {
    return JSON.parse(_currentDoc.getPageOfPosition(sectionIndex, paragraphIndex));
  } catch {
    return null;
  }
}

function loadPageTextLayout(pageIndex) {
  if (!_currentDoc) return { runs: [] };
  if (_pageTextLayoutCache.has(pageIndex)) {
    return _pageTextLayoutCache.get(pageIndex);
  }
  const layout = parseJsonSafely(_currentDoc.getPageTextLayout(pageIndex), { runs: [] }) || { runs: [] };
  _pageTextLayoutCache.set(pageIndex, layout);
  return layout;
}

function loadPageInfo(pageIndex) {
  if (!_currentDoc) return null;
  if (_pageInfoCache.has(pageIndex)) {
    return _pageInfoCache.get(pageIndex);
  }
  const info = parseJsonSafely(_currentDoc.getPageInfo(pageIndex), null);
  _pageInfoCache.set(pageIndex, info);
  return info;
}

function loadPageControlLayout(pageIndex) {
  if (!_currentDoc) return { controls: [] };
  if (_pageControlLayoutCache.has(pageIndex)) {
    return _pageControlLayoutCache.get(pageIndex);
  }
  const layout = parseJsonSafely(_currentDoc.getPageControlLayout(pageIndex), { controls: [] }) || { controls: [] };
  _pageControlLayoutCache.set(pageIndex, layout);
  return layout;
}

function toFiniteNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeControlType(control) {
  return String(control?.type || 'unknown').trim().toLowerCase();
}

function getControlBucket(type) {
  if (type === 'table') return 'tables';
  if (type.includes('equation') || type === 'eqedit') return 'equations';
  if (type.includes('chart')) return 'charts';
  if (type.includes('picture') || type.includes('image')) return 'pictures';
  if (type.includes('ole')) return 'oles';
  if (type.includes('video')) return 'videos';
  if (
    type.includes('form')
    || type.includes('button')
    || type.includes('check')
    || type.includes('radio')
    || type.includes('combo')
    || type.includes('listbox')
    || type.includes('edit')
    || type.includes('clickhere')
  ) {
    return 'forms';
  }
  if (type.includes('shape') || type.includes('draw') || type.includes('textbox') || type.includes('textart')) {
    return 'shapes';
  }
  return 'otherControls';
}

function createEmptyControlCounts() {
  return {
    controls: 0,
    tables: 0,
    tableRows: 0,
    tableCols: 0,
    tableCells: 0,
    pictures: 0,
    equations: 0,
    charts: 0,
    forms: 0,
    shapes: 0,
    oles: 0,
    videos: 0,
    otherControls: 0,
    textRuns: 0,
  };
}

function createEmptyLayoutSignals() {
  return {
    inlineControls: 0,
    floatingControls: 0,
    inlineTables: 0,
    floatingTables: 0,
    inlinePictures: 0,
    floatingPictures: 0,
    wrappedControls: 0,
    overlapAllowed: 0,
    keepWithAnchor: 0,
    restrictInPageDisabled: 0,
    repeatHeaderTables: 0,
    pageBreakTables: 0,
    paragraphAnchoredControls: 0,
    pageAnchoredControls: 0,
    columnAnchoredControls: 0,
    mergedCells: 0,
    multiRowSpanCells: 0,
    multiColSpanCells: 0,
    tallCells: 0,
    captionedPictures: 0,
    croppedPictures: 0,
    rotatedPictures: 0,
    flippedPictures: 0,
    wrapModes: {},
    vertRelTo: {},
    horzRelTo: {},
    tags: {},
  };
}

function incrementCount(target, key, amount = 1) {
  if (!target || !key || !Number.isFinite(amount)) return;
  target[key] = (target[key] || 0) + amount;
}

function incrementMapCount(target, key, amount = 1) {
  if (!target || !key || !Number.isFinite(amount)) return;
  target[key] = (target[key] || 0) + amount;
}

function normalizeLayoutValue(value, fallback = 'unknown') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function buildTableGeometrySummary(cells = []) {
  if (!Array.isArray(cells) || !cells.length) {
    return {
      mergedCells: 0,
      multiRowSpanCells: 0,
      multiColSpanCells: 0,
      tallCells: 0,
      maxCellHeight: 0,
      maxCellWidth: 0,
    };
  }

  let mergedCells = 0;
  let multiRowSpanCells = 0;
  let multiColSpanCells = 0;
  let tallCells = 0;
  let maxCellHeight = 0;
  let maxCellWidth = 0;

  for (const cell of cells) {
    const rowSpan = toFiniteNumber(cell?.rowSpan, 1);
    const colSpan = toFiniteNumber(cell?.colSpan, 1);
    const height = toFiniteNumber(cell?.h, 0);
    const width = toFiniteNumber(cell?.w, 0);
    if (rowSpan > 1 || colSpan > 1) mergedCells += 1;
    if (rowSpan > 1) multiRowSpanCells += 1;
    if (colSpan > 1) multiColSpanCells += 1;
    if (height >= 120) tallCells += 1;
    if (height > maxCellHeight) maxCellHeight = height;
    if (width > maxCellWidth) maxCellWidth = width;
  }

  return {
    mergedCells,
    multiRowSpanCells,
    multiColSpanCells,
    tallCells,
    maxCellHeight,
    maxCellWidth,
  };
}

function buildPictureGeometrySummary(picture = null) {
  const cropLeft = Math.abs(toFiniteNumber(picture?.cropLeft, 0));
  const cropTop = Math.abs(toFiniteNumber(picture?.cropTop, 0));
  const cropRight = Math.abs(toFiniteNumber(picture?.cropRight, 0));
  const cropBottom = Math.abs(toFiniteNumber(picture?.cropBottom, 0));
  const rotationAngle = toFiniteNumber(picture?.rotationAngle, 0);
  const hasCrop = (cropLeft + cropTop + cropRight + cropBottom) > 0;
  const rotated = Math.abs(rotationAngle) > 0.01;
  const flipped = Boolean(picture?.horzFlip || picture?.vertFlip);
  return {
    hasCrop,
    rotated,
    flipped,
  };
}

function pushLayoutTag(tags, condition, label) {
  if (condition) tags.push(label);
}

function annotateControlLayout(diagnostics, control) {
  const tags = [];
  const wrapMode = normalizeLayoutValue(diagnostics?.textWrap);
  const vertRelTo = normalizeLayoutValue(diagnostics?.vertRelTo);
  const horzRelTo = normalizeLayoutValue(diagnostics?.horzRelTo);
  const layoutMode = diagnostics?.treatAsChar === true
    ? 'inline'
    : diagnostics?.treatAsChar === false
      ? 'floating'
      : 'unknown';

  diagnostics.layoutMode = layoutMode;
  diagnostics.wrapMode = wrapMode;
  diagnostics.anchor = {
    vertical: vertRelTo,
    horizontal: horzRelTo,
  };

  pushLayoutTag(tags, layoutMode === 'inline', '글자처럼');
  pushLayoutTag(tags, layoutMode === 'floating', '떠있는배치');
  pushLayoutTag(tags, wrapMode !== 'unknown', `배치:${wrapMode}`);
  pushLayoutTag(tags, diagnostics?.allowOverlap === true, '겹침허용');
  pushLayoutTag(tags, diagnostics?.keepWithAnchor === true, 'anchor고정');
  pushLayoutTag(tags, diagnostics?.restrictInPage === false, '쪽밖허용');
  pushLayoutTag(tags, vertRelTo !== 'unknown', `세로:${vertRelTo}`);
  pushLayoutTag(tags, horzRelTo !== 'unknown', `가로:${horzRelTo}`);

  if (diagnostics.bucket === 'tables') {
    const cellSource = Array.isArray(diagnostics?.cells)
      ? diagnostics.cells
      : Array.isArray(control?.cells)
        ? control.cells
        : [];
    const tableGeometry = buildTableGeometrySummary(cellSource);
    diagnostics.tableGeometry = tableGeometry;
    pushLayoutTag(tags, diagnostics?.repeatHeader === true, '머리행반복');
    pushLayoutTag(tags, diagnostics?.pageBreak === 1, '셀나눔');
    pushLayoutTag(tags, tableGeometry.mergedCells > 0, '병합셀');
    pushLayoutTag(tags, tableGeometry.tallCells > 0, '큰셀');
  } else if (diagnostics.bucket === 'pictures') {
    const pictureGeometry = buildPictureGeometrySummary(diagnostics.picture);
    diagnostics.pictureGeometry = pictureGeometry;
    pushLayoutTag(tags, diagnostics?.hasCaption === true, '캡션');
    pushLayoutTag(tags, pictureGeometry.hasCrop, '자르기');
    pushLayoutTag(tags, pictureGeometry.rotated, '회전');
    pushLayoutTag(tags, pictureGeometry.flipped, '반전');
  }

  diagnostics.layoutTags = tags;
  return diagnostics;
}

function accumulateLayoutSignals(target, entry) {
  if (!target || !entry) return;

  if (entry.layoutMode === 'inline') incrementCount(target, 'inlineControls', 1);
  if (entry.layoutMode === 'floating') incrementCount(target, 'floatingControls', 1);
  if (entry.layoutMode === 'floating' || (entry.wrapMode !== 'unknown' && entry.wrapMode !== 'TopAndBottom')) {
    incrementCount(target, 'wrappedControls', 1);
  }
  if (entry.allowOverlap === true) incrementCount(target, 'overlapAllowed', 1);
  if (entry.keepWithAnchor === true) incrementCount(target, 'keepWithAnchor', 1);
  if (entry.restrictInPage === false) incrementCount(target, 'restrictInPageDisabled', 1);

  if (entry.anchor?.vertical === 'Para' || entry.anchor?.horizontal === 'Para') {
    incrementCount(target, 'paragraphAnchoredControls', 1);
  }
  if (entry.anchor?.vertical === 'Page' || entry.anchor?.horizontal === 'Page') {
    incrementCount(target, 'pageAnchoredControls', 1);
  }
  if (entry.anchor?.vertical === 'Column' || entry.anchor?.horizontal === 'Column') {
    incrementCount(target, 'columnAnchoredControls', 1);
  }

  incrementMapCount(target.wrapModes, entry.wrapMode, 1);
  incrementMapCount(target.vertRelTo, entry.anchor?.vertical || 'unknown', 1);
  incrementMapCount(target.horzRelTo, entry.anchor?.horizontal || 'unknown', 1);
  for (const tag of entry.layoutTags || []) {
    incrementMapCount(target.tags, tag, 1);
  }

  if (entry.bucket === 'tables') {
    if (entry.layoutMode === 'inline') incrementCount(target, 'inlineTables', 1);
    if (entry.layoutMode === 'floating') incrementCount(target, 'floatingTables', 1);
    if (entry.repeatHeader === true) incrementCount(target, 'repeatHeaderTables', 1);
    if (entry.pageBreak === 1) incrementCount(target, 'pageBreakTables', 1);
    incrementCount(target, 'mergedCells', toFiniteNumber(entry.tableGeometry?.mergedCells, 0));
    incrementCount(target, 'multiRowSpanCells', toFiniteNumber(entry.tableGeometry?.multiRowSpanCells, 0));
    incrementCount(target, 'multiColSpanCells', toFiniteNumber(entry.tableGeometry?.multiColSpanCells, 0));
    incrementCount(target, 'tallCells', toFiniteNumber(entry.tableGeometry?.tallCells, 0));
  } else if (entry.bucket === 'pictures') {
    if (entry.layoutMode === 'inline') incrementCount(target, 'inlinePictures', 1);
    if (entry.layoutMode === 'floating') incrementCount(target, 'floatingPictures', 1);
    if (entry.hasCaption === true) incrementCount(target, 'captionedPictures', 1);
    if (entry.pictureGeometry?.hasCrop) incrementCount(target, 'croppedPictures', 1);
    if (entry.pictureGeometry?.rotated) incrementCount(target, 'rotatedPictures', 1);
    if (entry.pictureGeometry?.flipped) incrementCount(target, 'flippedPictures', 1);
  }
}

function getSectionCount() {
  if (!_currentDoc) return 0;
  try {
    return _currentDoc.getSectionCount();
  } catch {
    const docInfo = parseJsonSafely(_currentDoc.getDocumentInfo(), {});
    return Number.isFinite(docInfo?.sectionCount) ? docInfo.sectionCount : 0;
  }
}

function getSectionDef(sectionIndex) {
  if (!_currentDoc) return null;
  return parseJsonSafely(_currentDoc.getSectionDef(sectionIndex), null);
}

function getPageDef(sectionIndex) {
  if (!_currentDoc) return null;
  return parseJsonSafely(_currentDoc.getPageDef(sectionIndex), null);
}

function getPageInfo(pageIndex) {
  return _currentDoc ? loadPageInfo(pageIndex) : null;
}

function getPageControlLayout(pageIndex) {
  return _currentDoc ? loadPageControlLayout(pageIndex) : { controls: [] };
}

function getTableDiagnostics(control) {
  if (!_currentDoc) return null;
  const secIdx = toFiniteNumber(control?.secIdx);
  const paraIdx = toFiniteNumber(control?.paraIdx);
  const controlIdx = toFiniteNumber(control?.controlIdx);
  if (secIdx == null || paraIdx == null || controlIdx == null) return null;
  try {
    const dimensions = parseJsonSafely(_currentDoc.getTableDimensions(secIdx, paraIdx, controlIdx), {});
    const properties = parseJsonSafely(_currentDoc.getTableProperties(secIdx, paraIdx, controlIdx), {});
    return { ...dimensions, ...properties };
  } catch (error) {
    console.warn('[HWP 진단] 표 속성 조회 실패:', error);
    return null;
  }
}

function getPictureDiagnostics(control) {
  if (!_currentDoc) return null;
  const secIdx = toFiniteNumber(control?.secIdx);
  const paraIdx = toFiniteNumber(control?.paraIdx);
  const controlIdx = toFiniteNumber(control?.controlIdx);
  if (secIdx == null || paraIdx == null || controlIdx == null) return null;
  try {
    return parseJsonSafely(_currentDoc.getPictureProperties(secIdx, paraIdx, controlIdx), null);
  } catch (error) {
    console.warn('[HWP 진단] 그림 속성 조회 실패:', error);
    return null;
  }
}

function getEquationDiagnostics(control) {
  if (!_currentDoc) return null;
  const secIdx = toFiniteNumber(control?.secIdx);
  const paraIdx = toFiniteNumber(control?.parentParaIdx ?? control?.paraIdx);
  const controlIdx = toFiniteNumber(control?.controlIdx);
  const cellIdx = toFiniteNumber(control?.cellIdx, -1);
  const cellParaIdx = toFiniteNumber(control?.cellParaIdx, -1);
  if (secIdx == null || paraIdx == null || controlIdx == null) return null;
  try {
    return parseJsonSafely(_currentDoc.getEquationProperties(secIdx, paraIdx, controlIdx, cellIdx, cellParaIdx), null);
  } catch (error) {
    console.warn('[HWP 진단] 수식 속성 조회 실패:', error);
    return null;
  }
}

function getFormDiagnostics(control) {
  if (!_currentDoc) return null;
  const secIdx = toFiniteNumber(control?.secIdx);
  const paraIdx = toFiniteNumber(control?.paraIdx);
  const controlIdx = toFiniteNumber(control?.controlIdx);
  if (secIdx == null || paraIdx == null || controlIdx == null) return null;
  try {
    return parseJsonSafely(_currentDoc.getFormObjectInfo(secIdx, paraIdx, controlIdx), null);
  } catch (error) {
    console.warn('[HWP 진단] 양식 속성 조회 실패:', error);
    return null;
  }
}

function buildControlDiagnostics(control, pageIndex, options = {}) {
  const includeControlDetails = options.includeControlDetails === true;
  const type = normalizeControlType(control);
  const bucket = getControlBucket(type);
  const diagnostics = {
    pageIndex,
    type,
    bucket,
    x: toFiniteNumber(control?.x),
    y: toFiniteNumber(control?.y),
    w: toFiniteNumber(control?.w),
    h: toFiniteNumber(control?.h),
    secIdx: toFiniteNumber(control?.secIdx),
    paraIdx: toFiniteNumber(control?.paraIdx),
    parentParaIdx: toFiniteNumber(control?.parentParaIdx),
    controlIdx: toFiniteNumber(control?.controlIdx),
    cellIdx: toFiniteNumber(control?.cellIdx),
    cellParaIdx: toFiniteNumber(control?.cellParaIdx),
  };

  if (bucket === 'tables') {
    const tableInfo = getTableDiagnostics(control);
    if (tableInfo) Object.assign(diagnostics, tableInfo);
    if (includeControlDetails && Array.isArray(control?.cells)) {
      diagnostics.cells = control.cells.map((cell) => ({
        cellIdx: toFiniteNumber(cell?.cellIdx),
        row: toFiniteNumber(cell?.row),
        col: toFiniteNumber(cell?.col),
        rowSpan: toFiniteNumber(cell?.rowSpan),
        colSpan: toFiniteNumber(cell?.colSpan),
        x: toFiniteNumber(cell?.x),
        y: toFiniteNumber(cell?.y),
        w: toFiniteNumber(cell?.w),
        h: toFiniteNumber(cell?.h),
      }));
    }
  } else if (bucket === 'pictures') {
    const pictureInfo = getPictureDiagnostics(control);
    if (pictureInfo) {
      diagnostics.picture = pictureInfo;
      diagnostics.treatAsChar = pictureInfo.treatAsChar;
      diagnostics.textWrap = pictureInfo.textWrap;
      diagnostics.vertRelTo = pictureInfo.vertRelTo;
      diagnostics.vertAlign = pictureInfo.vertAlign;
      diagnostics.horzRelTo = pictureInfo.horzRelTo;
      diagnostics.horzAlign = pictureInfo.horzAlign;
      diagnostics.vertOffset = toFiniteNumber(pictureInfo.vertOffset);
      diagnostics.horzOffset = toFiniteNumber(pictureInfo.horzOffset);
      diagnostics.hasCaption = Boolean(pictureInfo.hasCaption);
      diagnostics.captionDirection = pictureInfo.captionDirection;
    }
  } else if (bucket === 'equations') {
    const equationInfo = getEquationDiagnostics(control);
    if (equationInfo) diagnostics.equation = equationInfo;
  } else if (bucket === 'forms') {
    const formInfo = getFormDiagnostics(control);
    if (formInfo) diagnostics.form = formInfo;
  }

  if (includeControlDetails) {
    diagnostics.raw = control;
  }

  return annotateControlLayout(diagnostics, control);
}

function collectDocumentDiagnostics(options = {}) {
  if (!_currentDoc) {
    return {
      pageCount: 0,
      sectionCount: 0,
      documentInfo: null,
      counts: createEmptyControlCounts(),
      pages: [],
      sections: [],
      controlTypes: {},
    };
  }

  const includePageInfo = options.includePageInfo !== false;
  const includeSectionDetails = options.includeSectionDetails === true;
  const includeControlDetails = options.includeControlDetails === true;
  const pageCount = _currentDoc.pageCount();
  const sectionCount = getSectionCount();
  const documentInfo = parseJsonSafely(_currentDoc.getDocumentInfo(), null);
  const counts = createEmptyControlCounts();
  const layoutSignals = createEmptyLayoutSignals();
  const controlTypes = {};
  const pages = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageInfo = includePageInfo ? loadPageInfo(pageIndex) : null;
    const controlLayout = loadPageControlLayout(pageIndex);
    const controls = Array.isArray(controlLayout?.controls) ? controlLayout.controls : [];
    const textLayout = loadPageTextLayout(pageIndex);
    const pageControlTypes = {};
    const pageCounts = createEmptyControlCounts();
    const pageLayoutSignals = createEmptyLayoutSignals();
    const pageEntry = {
      pageIndex,
      controlCount: controls.length,
      counts: pageCounts,
      layoutSignals: pageLayoutSignals,
      controlTypes: pageControlTypes,
      textRunCount: Array.isArray(textLayout?.runs) ? textLayout.runs.length : 0,
    };

    if (pageInfo) {
      pageEntry.width = toFiniteNumber(pageInfo?.width);
      pageEntry.height = toFiniteNumber(pageInfo?.height);
      pageEntry.sectionIndex = toFiniteNumber(pageInfo?.sectionIndex);
      pageEntry.columns = Array.isArray(pageInfo?.columns) ? pageInfo.columns.length : 0;
      pageEntry.margins = {
        left: toFiniteNumber(pageInfo?.marginLeft),
        right: toFiniteNumber(pageInfo?.marginRight),
        top: toFiniteNumber(pageInfo?.marginTop),
        bottom: toFiniteNumber(pageInfo?.marginBottom),
        header: toFiniteNumber(pageInfo?.marginHeader),
        footer: toFiniteNumber(pageInfo?.marginFooter),
      };
    }

    incrementCount(counts, 'textRuns', pageEntry.textRunCount);
    incrementCount(pageCounts, 'textRuns', pageEntry.textRunCount);

    const controlEntries = [];
    for (const control of controls) {
      const entry = buildControlDiagnostics(control, pageIndex, { includeControlDetails });
      const bucket = entry.bucket || 'otherControls';
      const type = entry.type || 'unknown';
      incrementCount(counts, 'controls', 1);
      incrementCount(pageCounts, 'controls', 1);
      incrementCount(counts, bucket, 1);
      incrementCount(pageCounts, bucket, 1);
      if (bucket === 'tables') {
        incrementCount(counts, 'tableRows', toFiniteNumber(entry.rowCount, 0));
        incrementCount(counts, 'tableCols', toFiniteNumber(entry.colCount, 0));
        incrementCount(counts, 'tableCells', toFiniteNumber(entry.cellCount ?? entry.cells?.length, 0));
        incrementCount(pageCounts, 'tableRows', toFiniteNumber(entry.rowCount, 0));
        incrementCount(pageCounts, 'tableCols', toFiniteNumber(entry.colCount, 0));
        incrementCount(pageCounts, 'tableCells', toFiniteNumber(entry.cellCount ?? entry.cells?.length, 0));
      }
      incrementCount(controlTypes, type, 1);
      incrementCount(pageControlTypes, type, 1);
      accumulateLayoutSignals(layoutSignals, entry);
      accumulateLayoutSignals(pageLayoutSignals, entry);
      if (includeControlDetails) {
        controlEntries.push(entry);
      }
    }

    if (includeControlDetails) {
      pageEntry.controls = controlEntries;
    }

    pages.push(pageEntry);
  }

  const sections = [];
  if (includeSectionDetails) {
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
      sections.push({
        sectionIndex,
        paragraphCount: _currentDoc.getParagraphCount(sectionIndex),
        sectionDef: getSectionDef(sectionIndex),
        pageDef: getPageDef(sectionIndex),
      });
    }
  }

  return {
    pageCount,
    sectionCount,
    documentInfo,
    counts,
    layoutSignals,
    controlTypes,
    pages,
    sections,
  };
}

function searchBodyText(query, caseSensitive = false) {
  if (!_currentDoc || !query) return [];

  const results = [];
  let fromSec = 0;
  let fromPara = 0;
  let fromChar = 0;

  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i++) {
    let parsed = null;
    try {
      const result = _currentDoc.searchText(query, fromSec, fromPara, fromChar, true, caseSensitive);
      if (!result) break;
      parsed = JSON.parse(result);
    } catch {
      break;
    }

    if (!parsed?.found) break;

    const sec = parsed.sectionIndex ?? parsed.sec;
    const para = parsed.paragraphIndex ?? parsed.para;
    const charStart = parsed.charOffset ?? parsed.char;
    const length = parsed.length ?? [...query].length;
    const nextChar = Math.max(charStart + length, charStart + 1);

    if (sec == null || para == null || charStart == null) break;

    const pageInfo = getPageOfPosition(sec, para);
    results.push({
      ...parsed,
      sec,
      para,
      char: charStart,
      charOffset: charStart,
      char_end: nextChar,
      page: Number.isFinite(pageInfo?.page) ? pageInfo.page : null,
      source: 'body',
    });

    if (sec === fromSec && para === fromPara && nextChar <= fromChar) break;

    fromSec = sec;
    fromPara = para;
    fromChar = nextChar;
  }

  return results;
}

function searchRenderedPageText(query, caseSensitive = false) {
  if (!_currentDoc || !query) return [];

  const results = [];
  const pageCount = _currentDoc.pageCount();
  const queryChars = Array.from(query);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    let layout = { runs: [] };
    try {
      layout = loadPageTextLayout(pageIndex) || { runs: [] };
    } catch {
      continue;
    }

    for (const run of layout.runs || []) {
      const text = String(run?.text || '');
      const directOffsets = findQueryOffsets(text, query, caseSensitive)
        .map(offset => ({ start: offset, end: offset + queryChars.length }));
      const compactOffsets = findWhitespaceInsensitiveOffsets(text, query, caseSensitive);
      const offsets = [...directOffsets, ...compactOffsets];
      if (!offsets.length) continue;

      const charX = Array.isArray(run.charX) ? run.charX : [];
      const baseCharStart = Number.isFinite(run.charStart) ? run.charStart : null;

      for (const offset of offsets) {
        const x0 = Number.isFinite(charX[offset.start]) ? charX[offset.start] : 0;
        const x1 = Number.isFinite(charX[offset.end])
          ? charX[offset.end]
          : (Number.isFinite(run.w) ? run.w : x0);

        results.push({
          page: pageIndex,
          text,
          query,
          x: (Number.isFinite(run.x) ? run.x : 0) + x0,
          y: Number.isFinite(run.y) ? run.y : 0,
          w: Math.max(0, x1 - x0),
          h: Number.isFinite(run.h) ? run.h : 0,
          sec: Number.isFinite(run.secIdx) ? run.secIdx : null,
          para: Number.isFinite(run.paraIdx) ? run.paraIdx : null,
          char: baseCharStart != null ? baseCharStart + offset.start : null,
          charOffset: baseCharStart != null ? baseCharStart + offset.start : null,
          char_end: baseCharStart != null ? baseCharStart + offset.end : null,
          parentParaIdx: Number.isFinite(run.parentParaIdx) ? run.parentParaIdx : null,
          controlIdx: Number.isFinite(run.controlIdx) ? run.controlIdx : null,
          cellIdx: Number.isFinite(run.cellIdx) ? run.cellIdx : null,
          cellParaIdx: Number.isFinite(run.cellParaIdx) ? run.cellParaIdx : null,
          source: 'page-layout',
        });
      }
    }
  }

  return results;
}

/**
 * 현재 문서에서 텍스트를 검색한다.
 * @param {string} query
 * @param {boolean} caseSensitive
 * @returns {Array<{sec:number, para:number, char:number}>}
 */
function searchText(query, caseSensitive = false) {
  if (!_currentDoc || !query) return [];

  const bodyHits = searchBodyText(query, caseSensitive);
  const layoutHits = searchRenderedPageText(query, caseSensitive);

  if (!layoutHits.length) {
    return bodyHits;
  }

  const deduped = [];
  const seen = new Set();
  for (const hit of [...bodyHits, ...layoutHits]) {
    const hasDocPosition = Number.isFinite(hit.sec) && Number.isFinite(hit.para) && Number.isFinite(hit.charOffset ?? hit.char);
    const key = hasDocPosition
      ? ['doc', hit.page ?? '', hit.sec, hit.para, hit.charOffset ?? hit.char].join('|')
      : ['page', hit.page ?? '', hit.x ?? '', hit.y ?? '', hit.text ?? ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
  }
  return deduped;
}

function hitTest(pageIndex, x, y) {
  if (!_currentDoc) return null;
  return JSON.parse(_currentDoc.hitTest(pageIndex, x, y));
}

function getCursorRect(sectionIndex, paragraphIndex, charOffset) {
  if (!_currentDoc) return null;
  return JSON.parse(_currentDoc.getCursorRect(sectionIndex, paragraphIndex, charOffset));
}

function insertText(sectionIndex, paragraphIndex, charOffset, text) {
  if (!_currentDoc) {
    throw new Error('삽입할 문서가 없습니다.');
  }
  const result = JSON.parse(_currentDoc.insertText(sectionIndex, paragraphIndex, charOffset, text));
  clearRuntimeCaches();
  return result;
}

function deleteText(sectionIndex, paragraphIndex, charOffset, count) {
  if (!_currentDoc) {
    throw new Error('삭제할 문서가 없습니다.');
  }
  const result = JSON.parse(_currentDoc.deleteText(sectionIndex, paragraphIndex, charOffset, count));
  clearRuntimeCaches();
  return result;
}

function splitParagraph(sectionIndex, paragraphIndex, charOffset) {
  if (!_currentDoc) {
    throw new Error('줄을 나눌 문서가 없습니다.');
  }
  const result = JSON.parse(_currentDoc.splitParagraph(sectionIndex, paragraphIndex, charOffset));
  clearRuntimeCaches();
  return result;
}

function mergeParagraph(sectionIndex, paragraphIndex) {
  if (!_currentDoc) {
    throw new Error('문단을 합칠 문서가 없습니다.');
  }
  const result = JSON.parse(_currentDoc.mergeParagraph(sectionIndex, paragraphIndex));
  clearRuntimeCaches();
  return result;
}

function moveVertical(sectionIndex, paragraphIndex, charOffset, delta, preferredX) {
  if (!_currentDoc) {
    throw new Error('커서를 이동할 문서가 없습니다.');
  }
  return JSON.parse(_currentDoc.moveVertical(
    sectionIndex,
    paragraphIndex,
    charOffset,
    delta,
    preferredX,
    -1,
    -1,
    -1,
    -1,
  ));
}

function getParagraphLength(sectionIndex, paragraphIndex) {
  if (!_currentDoc) return 0;
  return _currentDoc.getParagraphLength(sectionIndex, paragraphIndex);
}

function getParagraphCount(sectionIndex) {
  if (!_currentDoc) return 0;
  return _currentDoc.getParagraphCount(sectionIndex);
}

function getPageTextLayout(pageIndex) {
  return _currentDoc ? loadPageTextLayout(pageIndex) : { runs: [] };
}

/**
 * 현재 로드된 문서를 HWP 바이너리로 내보낸다.
 * @returns {Uint8Array}
 */
function exportCurrentDocumentAsHwp() {
  if (!_currentDoc) {
    throw new Error('내보낼 문서가 없습니다.');
  }
  return _currentDoc.exportHwp();
}

/**
 * 현재 로드된 문서를 해제한다.
 */
function dispose() {
  if (_currentDoc) {
    try { _currentDoc.free(); } catch (e) { /* ignore */ }
    _currentDoc = null;
  }
  clearRuntimeCaches();
}

/**
 * WASM 초기화를 미리 시작한다.
 */
async function preloadWasm() {
  try { await ensureInit(); } catch (e) {
    console.warn('[HWP 엔진] 사전 로드 실패:', e);
  }
}

// window에 노출 — 일반 스크립트(app.js)에서 접근 가능하게
const hwpWasmRenderer = {
  renderDocument,
  rerenderAtZoom,
  searchText,
  hitTest,
  getCursorRect,
  insertText,
  deleteText,
  splitParagraph,
  mergeParagraph,
  moveVertical,
  getParagraphLength,
  getParagraphCount,
  getSectionCount,
  getSectionDef,
  getPageDef,
  getPageInfo,
  getPageControlLayout,
  getPageTextLayout,
  collectDocumentDiagnostics,
  exportHwp: exportCurrentDocumentAsHwp,
  dispose,
  isReady: () => _initialized,
  preload: preloadWasm,
  getCurrentDoc: () => _currentDoc,
};
window.HwpWasmRenderer = hwpWasmRenderer;

// 페이지 로드 즉시 WASM 초기화 시작 (백그라운드)
preloadWasm();
