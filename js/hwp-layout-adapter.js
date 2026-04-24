/**
 * hwp-layout-adapter.js — TotalDocs-owned WASM layout bridge
 *
 * The engine is intentionally layout-only at this stage. JS still owns parsing and
 * DOM rendering, while Rust/WASM returns a comparable page/box layout tree.
 */

(function attachTotalDocsLayoutEngine(global) {
  const KIND = {
    paragraph: 1,
    table: 2,
    image: 3,
    shape: 4,
  };
  const MAGIC = [0x54, 0x44, 0x4c, 0x4d]; // TDLM
  const VERSION = 1;
  const DEFAULT_PAGE = {
    width: 794,
    height: 1123,
    marginTop: 80,
    marginRight: 80,
    marginBottom: 80,
    marginLeft: 80,
  };

  let wasmExports = null;
  let initPromise = null;

  function resolveDefaultWasmUrl() {
    const scriptUrl = document.currentScript?.src || '';
    if (scriptUrl) {
      return new URL('../lib/generated/totaldocs_engine.wasm', scriptUrl).href;
    }
    return 'lib/generated/totaldocs_engine.wasm';
  }

  async function init(wasmUrl = resolveDefaultWasmUrl()) {
    if (wasmExports) return wasmExports;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let instance;
      if (typeof WebAssembly.instantiateStreaming === 'function' && typeof fetch === 'function') {
        try {
          const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), {});
          instance = result.instance;
        } catch {
          instance = null;
        }
      }
      if (!instance) {
        const response = await fetch(wasmUrl);
        if (!response.ok) throw new Error(`TotalDocs WASM 로드 실패: ${response.status}`);
        const bytes = await response.arrayBuffer();
        const result = await WebAssembly.instantiate(bytes, {});
        instance = result.instance;
      }
      wasmExports = instance.exports;
      return wasmExports;
    })();

    return initPromise;
  }

  function hwpUnitToPx(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 75)) : fallback;
  }

  function hwpxSizeToPx(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n * 96 / 2540)) : fallback;
  }

  function clampPx(value, min = 1, max = 20000) {
    const n = Math.round(Number(value) || 0);
    return Math.max(min, Math.min(max, n || min));
  }

  function pageFromDocument(doc = {}) {
    const pageStyle = (doc.pages || []).find(page => page?.pageStyle)?.pageStyle || {};
    const margins = pageStyle.margins || {};
    return {
      width: hwpUnitToPx(pageStyle.width, DEFAULT_PAGE.width),
      height: hwpUnitToPx(pageStyle.height, DEFAULT_PAGE.height),
      marginTop: hwpUnitToPx(margins.top, DEFAULT_PAGE.marginTop),
      marginRight: hwpUnitToPx(margins.right, DEFAULT_PAGE.marginRight),
      marginBottom: hwpUnitToPx(margins.bottom, DEFAULT_PAGE.marginBottom),
      marginLeft: hwpUnitToPx(margins.left, DEFAULT_PAGE.marginLeft),
    };
  }

  function textLength(block = {}) {
    return (block.texts || [])
      .map(run => String(run?.text || ''))
      .join('')
      .length;
  }

  function paragraphHeight(block = {}) {
    if (Array.isArray(block.lineSegs) && block.lineSegs.length) {
      const rawHeight = block.lineSegs.reduce((sum, seg) => (
        sum + Math.max(Number(seg?.height) || 0, Number(seg?.vertsize) || 0, Number(seg?.textheight) || 0)
      ), 0);
      const px = hwpUnitToPx(rawHeight, 0);
      if (px > 0) return px;
    }
    if (Number(block.layoutHeightPx) > 0) return clampPx(block.layoutHeightPx, 1, 4000);
    const lineHeight = Number(block.lineHeightPx) > 0 ? Number(block.lineHeightPx) : 20;
    const lines = Math.max(1, String((block.texts || []).map(run => run.text || '').join('')).split(/\n/).length);
    return clampPx(lineHeight * lines, 1, 4000);
  }

  function tableHeight(block = {}) {
    const explicitHwpx = Array.isArray(block.hwpxRowHeights)
      ? block.hwpxRowHeights.reduce((sum, value) => sum + (Number(value) || 0), 0)
      : 0;
    if (explicitHwpx > 0) return clampPx(hwpUnitToPx(explicitHwpx, 0), 1, 20000);

    const rowHeights = Array.isArray(block.rowHeights) ? block.rowHeights : [];
    const rowSum = rowHeights.reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (rowSum > 0) {
      return block.sourceFormat === 'hwpx'
        ? clampPx(rowSum * 20, 1, 20000)
        : clampPx(hwpUnitToPx(rowSum, rowSum), 1, 20000);
    }
    return clampPx(Math.max(1, Number(block.rowCount) || 1) * 28, 1, 20000);
  }

  function objectHeight(block = {}) {
    if (block.sourceFormat === 'hwpx') return hwpxSizeToPx(block.height, 24);
    return hwpUnitToPx(block.height, 24);
  }

  function blockRecord(block = {}, index = 0, page = DEFAULT_PAGE) {
    const type = String(block.type || 'paragraph');
    const kind = KIND[type] || KIND.paragraph;
    const width = type === 'table'
      ? Math.min(page.width - page.marginLeft - page.marginRight, 1200)
      : (block.sourceFormat === 'hwpx' ? hwpxSizeToPx(block.width, 0) : hwpUnitToPx(block.width, 0));
    let height;
    if (type === 'table') {
      height = tableHeight(block);
    } else if (type === 'image' || type === 'shape' || type === 'textbox') {
      height = objectHeight(block);
    } else {
      height = paragraphHeight(block);
    }

    let flags = 0;
    if ((block.numHeaderRows || 0) > 0) flags |= 1;
    if (String(block.pageBreak || block.rawLayout?.pageBreak || '').toUpperCase() !== '') flags |= 2;
    if (block.allowOverlap) flags |= 4;

    return {
      kind,
      width: clampPx(width || (page.width - page.marginLeft - page.marginRight), 1, 20000),
      height: clampPx(height, 1, 30000),
      minHeight: type === 'paragraph' ? 1 : 4,
      flags,
      sourceIndex: index,
      textLength: textLength(block),
    };
  }

  function flattenBlocks(doc = {}) {
    return (doc.pages || []).flatMap(page => page?.paragraphs || []);
  }

  function encodeLayoutInput(doc = {}, options = {}) {
    const page = { ...pageFromDocument(doc), ...(options.page || {}) };
    const blocks = (options.blocks || flattenBlocks(doc)).map((block, index) => blockRecord(block, index, page));
    const u32Count = 8 + blocks.length * 6;
    const bytes = new Uint8Array(4 + u32Count * 4);
    bytes.set(MAGIC, 0);
    const view = new DataView(bytes.buffer);
    let offset = 4;
    [
      VERSION,
      page.width,
      page.height,
      page.marginTop,
      page.marginRight,
      page.marginBottom,
      page.marginLeft,
      blocks.length,
    ].forEach(value => {
      view.setUint32(offset, clampPx(value, 0, 0xffffffff), true);
      offset += 4;
    });
    blocks.forEach(block => {
      [
        block.kind,
        block.width,
        block.height,
        block.minHeight,
        block.flags,
        block.sourceIndex,
      ].forEach(value => {
        view.setUint32(offset, clampPx(value, 0, 0xffffffff), true);
        offset += 4;
      });
    });
    return { bytes, page, blocks };
  }

  async function layoutDocument(doc = {}, options = {}) {
    const exports = await init(options.wasmUrl);
    const { bytes, page, blocks } = encodeLayoutInput(doc, options);
    const inputCapacity = exports.td_input_capacity();
    if (bytes.length > inputCapacity) {
      throw new Error(`TotalDocs WASM 입력 초과: ${bytes.length}/${inputCapacity}`);
    }

    const inputPtr = exports.td_input_ptr();
    new Uint8Array(exports.memory.buffer, inputPtr, bytes.length).set(bytes);

    const code = exports.td_layout(bytes.length);
    if (code !== 0) {
      throw new Error(`TotalDocs WASM layout 실패: code=${code}, lastError=${exports.td_last_error()}`);
    }

    const outputPtr = exports.td_output_ptr();
    const outputLen = exports.td_output_len();
    const json = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, outputPtr, outputLen));
    return {
      ...JSON.parse(json),
      input: {
        page,
        blockCount: blocks.length,
      },
    };
  }

  global.TotalDocsLayoutEngine = {
    init,
    isReady: () => Boolean(wasmExports),
    encodeLayoutInput,
    layoutDocument,
  };
})(typeof window !== 'undefined' ? window : globalThis);
