/**
 * rhwp-wasm-renderer.js — @rhwp/core WASM 기반 HWP Canvas 렌더링 브리지
 *
 * MIT License: Based on @rhwp/core by Edward Kim (https://github.com/edwardkim/rhwp)
 *
 * 이 모듈은 ES module로 로드됩니다 (viewer.html에서 <script type="module">).
 * 초기화 후 window.RhwpWasmRenderer 를 통해 일반 스크립트에서도 접근 가능합니다.
 *
 * 의존: lib/rhwp.js, lib/rhwp_bg.wasm, js/font_substitution.js
 */

// ─── LRU measureTextWidth 캐시 (rhwp editor.html 방식) ───
// WASM layout.rs의 estimate_text_width() / compute_char_positions()가 이 함수를 호출한다.
// 256 엔트리 LRU 캐시로 중복 측정을 방지한다.
if (typeof globalThis.measureTextWidth === 'undefined') {
  let _ctx = null;
  let _lastFont = '';
  const _cache = new Map();
  const MAX_CACHE = 256;
  const EVICT_COUNT = 64; // 25% 퇴거

  globalThis.measureTextWidth = function(font, text) {
    const key = font + '\0' + text;

    if (_cache.has(key)) {
      const val = _cache.get(key);
      _cache.delete(key);
      _cache.set(key, val); // MRU로 이동
      return val;
    }

    if (!_ctx) _ctx = document.createElement('canvas').getContext('2d');
    if (font !== _lastFont) { _ctx.font = font; _lastFont = font; }

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

import initWasm, { HwpDocument, version as rhwpVersion } from '../lib/rhwp.js';

let _initialized = false;
let _initPromise = null;

// 현재 로드된 문서 (zoom 재렌더 위해 doc 유지)
let _currentDoc = null;

/**
 * WASM 모듈을 초기화한다 (최초 1회만 실행).
 */
async function ensureInit() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = initWasm().then(() => {
    _initialized = true;
    console.log(`[rhwp WASM] 초기화 완료 v${rhwpVersion()}`);
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
    const capturedI = i;
    const capturedCanvas = canvas;
    setTimeout(() => {
      if (_currentDoc === doc) {
        try { doc.renderPageToCanvas(capturedI, capturedCanvas, zoom); } catch (e) { /* ignore */ }
      }
    }, 200);

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

/**
 * 현재 문서에서 텍스트를 검색한다.
 * @param {string} query
 * @param {boolean} caseSensitive
 * @returns {Array<{sec:number, para:number, char:number}>}
 */
function searchText(query, caseSensitive = false) {
  if (!_currentDoc || !query) return [];

  const results = [];
  let fromSec = 0, fromPara = 0, fromChar = 0;

  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i++) {
    try {
      const result = _currentDoc.searchText(query, fromSec, fromPara, fromChar, true, caseSensitive);
      if (!result) break;
      const r = JSON.parse(result);
      if (!r || r.sec === undefined) break;
      results.push(r);
      fromSec = r.sec;
      fromPara = r.para;
      fromChar = r.char_end !== undefined ? r.char_end : (r.char + query.length);
    } catch (e) {
      break;
    }
  }
  return results;
}

/**
 * 현재 로드된 문서를 해제한다.
 */
function dispose() {
  if (_currentDoc) {
    try { _currentDoc.free(); } catch (e) { /* ignore */ }
    _currentDoc = null;
  }
}

/**
 * WASM 초기화를 미리 시작한다.
 */
async function preloadWasm() {
  try { await ensureInit(); } catch (e) {
    console.warn('[rhwp WASM] 사전 로드 실패:', e);
  }
}

// window에 노출 — 일반 스크립트(app.js)에서 접근 가능하게
window.RhwpWasmRenderer = {
  renderDocument,
  rerenderAtZoom,
  searchText,
  dispose,
  isReady: () => _initialized,
  preload: preloadWasm,
  getCurrentDoc: () => _currentDoc,
};

// 페이지 로드 즉시 WASM 초기화 시작 (백그라운드)
preloadWasm();
