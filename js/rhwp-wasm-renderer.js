/**
 * rhwp-wasm-renderer.js — @rhwp/core WASM 기반 HWP 렌더링 브리지
 *
 * MIT License: Based on @rhwp/core by Edward Kim (https://github.com/edwardkim/rhwp)
 *
 * 이 모듈은 ES module로 로드됩니다 (viewer.html에서 <script type="module">).
 * 초기화 후 window.RhwpWasmRenderer 를 통해 일반 스크립트에서도 접근 가능합니다.
 *
 * 의존: lib/rhwp.js, lib/rhwp_bg.wasm
 */

// WASM이 텍스트 폭을 측정할 때 사용하는 전역 함수 (rhwp 필수 요건)
if (typeof globalThis.measureTextWidth === 'undefined') {
  let _measureCanvas = null;
  globalThis.measureTextWidth = (font, text) => {
    if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
    const ctx = _measureCanvas.getContext('2d');
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

import initWasm, { HwpDocument, version as rhwpVersion } from '../lib/rhwp.js';

let _initialized = false;
let _initPromise = null;

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
 * HWP/HWPX 바이너리를 WASM으로 렌더링하여 페이지별 SVG 배열을 반환한다.
 *
 * @param {ArrayBuffer} buffer — HWP/HWPX 파일 바이너리
 * @returns {Promise<{pageCount: number, pages: Array<{svg: string, index: number}>}>}
 */
async function renderDocument(buffer) {
  await ensureInit();

  const data = new Uint8Array(buffer);
  const doc = new HwpDocument(data);

  try {
    const pageCount = doc.pageCount();
    const pages = [];

    for (let i = 0; i < pageCount; i++) {
      const svg = doc.renderPageSvg(i);
      pages.push({ svg, index: i });
    }

    return { pageCount, pages };
  } finally {
    doc.free();
  }
}

/**
 * WASM 초기화를 미리 시작한다 (optional — 빠른 첫 렌더 위해 사전 호출).
 */
async function preloadWasm() {
  try {
    await ensureInit();
  } catch (e) {
    console.warn('[rhwp WASM] 사전 로드 실패:', e);
  }
}

// window에 노출 — 일반 스크립트(app.js)에서 접근 가능하게
window.RhwpWasmRenderer = {
  renderDocument,
  isReady: () => _initialized,
  preload: preloadWasm,
};

// 페이지 로드 즉시 WASM 초기화 시작 (백그라운드)
preloadWasm();
